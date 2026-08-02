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
  assertions: number;
  matchers: string[];
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
  const allMatchers: string[] = [];
  const looseAssertions: Array<{ pos: number }> = [];

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const calleeText = dotted(ts, node.expression, sourceFile);
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
        const name = titleNode !== undefined && ts.isStringLiteralLike(titleNode)
          ? titleNode.text
          : `${declarationText}@${parsed.lineOf(node.getStart(sourceFile))}`;

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
      tests: payload.tests,
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
