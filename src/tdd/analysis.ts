import type * as TS from "typescript";

import { exec, pythonBin } from "../shared/exec.js";
import { isPythonFile, isTypeScriptLike, parseSource } from "../shared/ast/ts.js";

import {
  ASSERTION_ROOTS,
  EACH_MODIFIERS,
  FOCUSED_DECLARATIONS,
  MOCK_CALLS,
  ONLY_MODIFIERS,
  SKIPPED_DECLARATIONS,
  SKIP_MODIFIERS,
  TEST_DECLARATIONS,
} from "./vocabulary.js";

/**
 * Structural facts about a test file, in a form both languages produce.
 *
 * Everything the four gates need is here, so the gates themselves are pure
 * comparisons over two of these — which is what makes them testable without a
 * parser, a repo, or a running Claude Code.
 */

export interface TestFact {
  /** Test title, or the function name in Python. */
  readonly name: string;
  readonly line: number;
  readonly assertions: number;
  /** Matcher names used inside this test, in source order. */
  readonly matchers: readonly string[];
  readonly skipped: boolean;
  readonly focused: boolean;
  /**
   * True for a grouping declaration (`describe`, `suite`, `context`).
   *
   * A group that happens to contain no inner `it` — only a `beforeEach`, or
   * tests registered by a helper call — survives the leaf filter below, and
   * without this flag gate 4 reported `test "suite" asserts nothing` about a
   * block that was never a test.
   */
  readonly suite: boolean;
}

export interface TestFileAnalysis {
  readonly tests: readonly TestFact[];
  readonly totalAssertions: number;
  /** Module specifiers passed to a mocking call. */
  readonly mockedModules: readonly string[];
  /** Every matcher in the file, for downgrade detection. */
  readonly matchers: readonly string[];
  /** True when the file could not be parsed; gates then decline to judge. */
  readonly unparsed: boolean;
}

export const EMPTY_ANALYSIS: TestFileAnalysis = {
  tests: [],
  totalAssertions: 0,
  mockedModules: [],
  matchers: [],
  unparsed: true,
};

function dotted(ts: typeof TS, node: TS.Node, sf: TS.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, "");
}

/**
 * Walk an `expect(...)` chain to its matcher.
 *
 * `expect(a).not.toBe(b)` and `expect(p).resolves.toEqual(q)` both bottom out at
 * an `expect` call; the matcher is the property being invoked at the top.
 */
function matcherOf(ts: typeof TS, call: TS.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const matcher = call.expression.name.text;

  let cursor: TS.Node = call.expression.expression;
  for (let depth = 0; depth < 8; depth++) {
    if (ts.isCallExpression(cursor)) {
      const callee = cursor.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (ASSERTION_ROOTS.has(name)) return matcher;
      cursor = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(cursor)) {
      cursor = cursor.expression;
      continue;
    }
    if (ts.isIdentifier(cursor) && ASSERTION_ROOTS.has(cursor.text)) return matcher;
    return null;
  }
  return null;
}

interface TestRange {
  readonly name: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly skipped: boolean;
  readonly focused: boolean;
  readonly suite: boolean;
  assertions: number;
  matchers: string[];
}

/** Declarations that group tests rather than being one. */
const SUITE_ROOTS = new Set(["describe", "suite", "context", "fdescribe", "xdescribe"]);

/** A named function in the test file, as a source range. */
interface FunctionRange {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

interface CallSite {
  readonly name: string;
  readonly pos: number;
}

const within = (pos: number, start: number, end: number): boolean => pos >= start && pos <= end;

/**
 * Local functions that assert, directly or through another local function.
 *
 * A shared expectation helper is the normal way to keep a suite readable:
 *
 * ```ts
 * function expectValidUser(u) { expect(u.ok).toBe(true); }
 * it("registers a user", () => expectValidUser(register()));
 * ```
 *
 * Counting assertions only inside a test's own source range calls that test
 * assertion-free and blocks the edit. Nothing here crosses a file boundary —
 * a call to a function *defined in this file* whose body asserts is enough,
 * and anything else stays a miss rather than a false block.
 */
function assertingFunctions(
  functions: readonly FunctionRange[],
  calls: readonly CallSite[],
  assertions: ReadonlyArray<{ readonly pos: number }>,
): ReadonlySet<string> {
  const asserting = new Set<string>();
  for (const fn of functions) {
    if (assertions.some((a) => within(a.pos, fn.start, fn.end))) asserting.add(fn.name);
  }

  // Helpers that delegate to other helpers. Depth is bounded because a chain
  // deeper than this does not occur and an unbounded fixpoint over a
  // pathological file is a hook-latency problem.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const fn of functions) {
      if (asserting.has(fn.name)) continue;
      const delegates = calls.some(
        (c) => c.name !== fn.name && asserting.has(c.name) && within(c.pos, fn.start, fn.end),
      );
      if (delegates) {
        asserting.add(fn.name);
        grew = true;
      }
    }
    if (!grew) break;
  }

  return asserting;
}

/** Name and range of a function-shaped declaration, or null. */
function namedFunction(ts: typeof TS, node: TS.Node, sf: TS.SourceFile): FunctionRange | null {
  const isFunctionLike = (n: TS.Node | undefined): boolean =>
    n !== undefined && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));

  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return { name: node.name.text, start: node.getStart(sf), end: node.getEnd() };
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    isFunctionLike(node.initializer)
  ) {
    return { name: node.name.text, start: node.getStart(sf), end: node.getEnd() };
  }
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    isFunctionLike(node.initializer)
  ) {
    return { name: node.name.text, start: node.getStart(sf), end: node.getEnd() };
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, start: node.getStart(sf), end: node.getEnd() };
  }
  return null;
}

/** Analyse a TypeScript/JavaScript test file. */
export async function analyseTypeScriptTests(
  filePath: string,
  source: string,
): Promise<TestFileAnalysis> {
  const parsed = await parseSource(filePath, source);
  if (parsed === null) return EMPTY_ANALYSIS;

  const { ts, sourceFile } = parsed;
  const ranges: TestRange[] = [];
  const mockedModules: string[] = [];
  /**
   * Ordinal for declarations whose title is not a string literal — a template
   * with substitutions, say, whose runtime name we cannot know.
   *
   * Numbered by position among unnamed declarations rather than by line: a
   * line-based name shifts whenever anything above it is edited, and gate 1
   * then reads the shift as a deleted test. That fired on this repo's own suite.
   */
  let unnamedOrdinal = 0;
  const allMatchers: string[] = [];
  const looseAssertions: Array<{ pos: number }> = [];
  const functions: FunctionRange[] = [];
  const calls: CallSite[] = [];

  const visit = (node: TS.Node): void => {
    const fn = namedFunction(ts, node, sourceFile);
    if (fn !== null) functions.push(fn);

    if (ts.isCallExpression(node)) {
      const calleeText = dotted(ts, node.expression, sourceFile);

      // Every call site, for the shared-helper pass below.
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (calleeName !== "") calls.push({ name: calleeName, pos: node.getStart(sourceFile) });
      const root = calleeText.split(".")[0] ?? "";
      const modifier = calleeText.split(".").slice(1).join(".");

      // ---- module mocks ----
      if (MOCK_CALLS.has(calleeText)) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteralLike(first)) {
          mockedModules.push(first.text);
        }
      }

      // ---- test declarations ----
      // `it.each(table)(name, fn)` is curried: the inner call carries the table
      // and the outer call carries the body. The outer one is the declaration.
      const curried = ts.isCallExpression(node.expression)
        ? dotted(ts, node.expression.expression, sourceFile)
        : null;
      const curriedModifier = curried === null ? "" : curried.split(".").slice(1).join(".");
      const isCurriedDeclaration =
        curried !== null &&
        TEST_DECLARATIONS.has(curried.split(".")[0] ?? "") &&
        EACH_MODIFIERS.has(curriedModifier);

      const isDirectDeclaration =
        (TEST_DECLARATIONS.has(root) && !EACH_MODIFIERS.has(modifier)) ||
        SKIPPED_DECLARATIONS.has(calleeText) ||
        FOCUSED_DECLARATIONS.has(calleeText);

      if (isDirectDeclaration || isCurriedDeclaration) {
        const declarationText = isCurriedDeclaration && curried !== null ? curried : calleeText;
        const declarationModifier = isCurriedDeclaration ? curriedModifier : modifier;
        const titleNode = node.arguments[0];
        const name =
          titleNode !== undefined && ts.isStringLiteralLike(titleNode)
            ? titleNode.text
            : `${declarationText}#${unnamedOrdinal++}`;

        ranges.push({
          name,
          line: parsed.lineOf(node.getStart(sourceFile)),
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          skipped:
            SKIPPED_DECLARATIONS.has(declarationText) ||
            SKIP_MODIFIERS.has(declarationModifier) ||
            declarationModifier.startsWith("skip."),
          focused:
            FOCUSED_DECLARATIONS.has(declarationText) ||
            ONLY_MODIFIERS.has(declarationModifier) ||
            declarationModifier.startsWith("only."),
          suite: SUITE_ROOTS.has(declarationText.split(".")[0] ?? ""),
          assertions: 0,
          matchers: [],
        });
      }

      // ---- assertions ----
      const matcher = matcherOf(ts, node);
      if (matcher !== null) {
        allMatchers.push(matcher);
        looseAssertions.push({ pos: node.getStart(sourceFile) });
      } else if (ASSERTION_ROOTS.has(root) && modifier !== "" && !TEST_DECLARATIONS.has(root)) {
        // `assert.equal(a, b)` style: the modifier is the matcher.
        allMatchers.push(modifier);
        looseAssertions.push({ pos: node.getStart(sourceFile) });
      } else if (ASSERTION_ROOTS.has(calleeText) && calleeText === "assert") {
        // Bare `assert(cond)`.
        allMatchers.push("assert");
        looseAssertions.push({ pos: node.getStart(sourceFile) });
      }
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);

  // Assign each assertion to the innermost test containing it. `describe`
  // blocks contain `it` blocks, so narrowest-range wins.
  for (const assertion of looseAssertions) {
    let best: TestRange | null = null;
    for (const range of ranges) {
      if (assertion.pos < range.start || assertion.pos > range.end) continue;
      if (best === null || range.end - range.start < best.end - best.start) best = range;
    }
    if (best !== null) best.assertions++;
  }

  for (let i = 0; i < allMatchers.length; i++) {
    const assertion = looseAssertions[i];
    const matcher = allMatchers[i];
    if (assertion === undefined || matcher === undefined) continue;
    let best: TestRange | null = null;
    for (const range of ranges) {
      if (assertion.pos < range.start || assertion.pos > range.end) continue;
      if (best === null || range.end - range.start < best.end - best.start) best = range;
    }
    if (best !== null) best.matchers.push(matcher);
  }

  // A test whose assertions live in a shared helper still asserts.
  const asserting = assertingFunctions(functions, calls, looseAssertions);
  if (asserting.size > 0) {
    for (const range of ranges) {
      if (range.assertions > 0) continue;
      const delegates = calls.some(
        (c) => asserting.has(c.name) && within(c.pos, range.start, range.end),
      );
      if (delegates) range.assertions = 1;
    }
  }

  // Only leaf tests count; a `describe` wrapper is not a test.
  const leaves = ranges.filter(
    (range) => !ranges.some((other) => other !== range && other.start > range.start && other.end < range.end),
  );

  return {
    tests: leaves.map((range) => ({
      name: range.name,
      line: range.line,
      assertions: range.assertions,
      matchers: range.matchers,
      skipped: range.skipped,
      focused: range.focused,
      suite: range.suite,
    })),
    totalAssertions: looseAssertions.length,
    mockedModules,
    matchers: allMatchers,
    unparsed: false,
  };
}

interface PythonAnalysisPayload {
  readonly tests: ReadonlyArray<{
    readonly name: string;
    readonly line: number;
    readonly assertions: number;
    readonly matchers: readonly string[];
    readonly skipped: boolean;
    readonly focused: boolean;
  }>;
  readonly total_assertions: number;
  readonly mocked_modules: readonly string[];
  readonly matchers: readonly string[];
  readonly unparsed: boolean;
}

/** Analyse a Python test file via `keel_gates.tdd`. */
export function analysePythonTests(
  pluginRoot: string,
  filePath: string,
  source: string,
): TestFileAnalysis {
  const res = exec(pythonBin(), ["-m", "keel_gates.tdd"], {
    cwd: `${pluginRoot}/python`,
    input: JSON.stringify({ path: filePath, source }),
    timeoutMs: 8000,
  });

  if (!res.ok || res.value.code !== 0) return EMPTY_ANALYSIS;

  try {
    const payload = JSON.parse(res.value.stdout) as PythonAnalysisPayload;
    return {
      // Python reports test *functions* only — a class is walked into rather
      // than reported — so nothing coming back from it is a grouping block.
      tests: payload.tests.map((t) => ({ ...t, suite: false })),
      totalAssertions: payload.total_assertions,
      mockedModules: payload.mocked_modules,
      matchers: payload.matchers,
      unparsed: payload.unparsed,
    };
  } catch {
    return EMPTY_ANALYSIS;
  }
}

/** Analyse a test file in whichever language it is written in. */
export async function analyseTests(
  pluginRoot: string,
  filePath: string,
  source: string,
): Promise<TestFileAnalysis> {
  if (isPythonFile(filePath)) return analysePythonTests(pluginRoot, filePath, source);
  if (isTypeScriptLike(filePath)) return analyseTypeScriptTests(filePath, source);
  return EMPTY_ANALYSIS;
}

/** Count occurrences of each matcher name. */
export function matcherCounts(analysis: TestFileAnalysis): Map<string, number> {
  const counts = new Map<string, number>();
  for (const matcher of analysis.matchers) {
    counts.set(matcher, (counts.get(matcher) ?? 0) + 1);
  }
  return counts;
}
