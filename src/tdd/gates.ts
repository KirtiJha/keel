import type { TestFileAnalysis } from "./analysis.js";
import { matcherCounts } from "./analysis.js";
import { specifierTargetsModule } from "./pairing.js";
import type { RedStatus } from "./state.js";
import {
  MATCHER_DOWNGRADES,
  PYTHON_MATCHER_DOWNGRADES,
  SNAPSHOT_MATCHERS,
  WEAK_MATCHERS,
  type OverrideDirective,
  overrideFor,
} from "./vocabulary.js";

/**
 * The four agent-specific TDD failure modes, as pure comparisons.
 *
 * None of these touch the filesystem, git, or a parser — they take analyses in
 * and give violations out. That is what makes them testable in isolation and
 * what keeps their behaviour explainable when one of them blocks somebody.
 */

export type GateName = "test-weakening" | "mock-under-test" | "observed-red" | "assertion-lint";

export interface TddViolation {
  readonly gate: GateName;
  readonly line?: number;
  readonly message: string;
  readonly fix: string;
}

export interface GateOutcome {
  readonly gate: GateName;
  readonly violations: readonly TddViolation[];
  /** True when a `keel: allow-test-change` comment suppressed a real finding. */
  readonly overridden: boolean;
  /** Reasons given in override comments, for telemetry. */
  readonly overrideReasons: readonly string[];
}

const clean = (gate: GateName): GateOutcome => ({
  gate,
  violations: [],
  overridden: false,
  overrideReasons: [],
});

/**
 * Gate 1 — test weakening.
 *
 * The cheapest path to green is to make the test ask for less. This compares
 * the test file before and after the edit and blocks four specific shapes.
 */
export function gateTestWeakening(
  before: TestFileAnalysis,
  after: TestFileAnalysis,
  overrides: readonly OverrideDirective[],
  language: "typescript" | "python",
): GateOutcome {
  // Nothing to compare against: a brand-new test file cannot weaken anything.
  if (before.unparsed || after.unparsed) return clean("test-weakening");

  const violations: TddViolation[] = [];
  const overrideReasons: string[] = [];
  let overridden = false;

  const record = (violation: TddViolation): void => {
    const override = violation.line === undefined ? null : overrideFor(overrides, violation.line);
    // A violation with no line (a removed test, a dropped assertion) is a
    // whole-file finding, so a file-level override covers it.
    const fileLevel = violation.line === undefined ? (overrides[0] ?? null) : null;
    const applied = override ?? fileLevel;
    if (applied !== null && applied !== undefined) {
      overridden = true;
      overrideReasons.push(applied.reason);
      return;
    }
    violations.push(violation);
  };

  // ---- a test function disappeared ----
  const beforeNames = new Set(before.tests.map((t) => t.name));
  const afterNames = new Set(after.tests.map((t) => t.name));
  const removed = [...beforeNames].filter((name) => !afterNames.has(name));
  if (removed.length > 0) {
    record({
      gate: "test-weakening",
      message: `${removed.length} test${removed.length === 1 ? "" : "s"} removed: ${removed.slice(0, 3).join(", ")}`,
      fix: "restore the test, or add `keel: allow-test-change <why it is no longer meaningful>` on the line",
    });
  }

  // ---- assertions went down ----
  if (after.totalAssertions < before.totalAssertions) {
    record({
      gate: "test-weakening",
      message: `assertion count fell from ${before.totalAssertions} to ${after.totalAssertions}`,
      fix: "keep the assertions, or justify the removal with `keel: allow-test-change <reason>`",
    });
  }

  // ---- a matcher was loosened ----
  const beforeCounts = matcherCounts(before);
  const afterCounts = matcherCounts(after);
  const downgrades = language === "python" ? PYTHON_MATCHER_DOWNGRADES : MATCHER_DOWNGRADES;

  for (const [strong, weakerList] of Object.entries(downgrades)) {
    const lost = (beforeCounts.get(strong) ?? 0) - (afterCounts.get(strong) ?? 0);
    if (lost <= 0) continue;
    for (const weak of weakerList) {
      const gained = (afterCounts.get(weak) ?? 0) - (beforeCounts.get(weak) ?? 0);
      if (gained <= 0) continue;
      // The line of the first test that now uses the weaker matcher.
      const test = after.tests.find((t) => t.matchers.includes(weak));
      record({
        gate: "test-weakening",
        ...(test === undefined ? {} : { line: test.line }),
        message: `matcher loosened: \`${strong}\` replaced by \`${weak}\``,
        fix: `assert the actual value with \`${strong}\`, or explain with \`keel: allow-test-change <reason>\``,
      });
      break;
    }
  }

  // ---- a test was switched off ----
  for (const test of after.tests) {
    const previous = before.tests.find((t) => t.name === test.name);
    if (test.skipped && previous?.skipped !== true) {
      record({
        gate: "test-weakening",
        line: test.line,
        message: `test "${test.name}" was marked skipped`,
        fix: "make the test pass, or record why it is skipped with `keel: allow-test-change <reason>`",
      });
    }
    if (test.focused && previous?.focused !== true) {
      record({
        gate: "test-weakening",
        line: test.line,
        message: `test "${test.name}" was marked \`.only\`, which silently skips every sibling test`,
        fix: "remove `.only` before committing",
      });
    }
  }

  return { gate: "test-weakening", violations, overridden, overrideReasons };
}

/**
 * Gate 2 — mocking the unit under test.
 *
 * Mocking the module a test exists to exercise makes the test pass without the
 * implementation existing, which is precisely the shortcut TDD is meant to
 * prevent. Mocking *collaborators* stays fine.
 */
export function gateMockUnderTest(
  testFilePath: string,
  analysis: TestFileAnalysis,
): GateOutcome {
  if (analysis.unparsed) return clean("mock-under-test");

  const offenders = analysis.mockedModules.filter((spec) =>
    specifierTargetsModule(spec, testFilePath),
  );
  if (offenders.length === 0) return clean("mock-under-test");

  return {
    gate: "mock-under-test",
    violations: [
      {
        gate: "mock-under-test",
        message: `this test mocks the module it is testing (${offenders[0] ?? ""})`,
        fix: "mock the collaborators instead and let the unit under test run for real",
      },
    ],
    overridden: false,
    overrideReasons: [],
  };
}

/**
 * Gate 3 — observed RED.
 *
 * Blocks implementation of a *new* exported symbol when no corresponding test
 * has been seen failing. Existing symbols are untouched, so refactoring and
 * bug-fixing are unaffected.
 */
export function gateObservedRed(
  newSymbols: readonly string[],
  status: RedStatus,
  sourcePath: string,
): GateOutcome {
  if (newSymbols.length === 0) return clean("observed-red");
  if (status.observed) return clean("observed-red");

  const names = newSymbols.slice(0, 3).join(", ");
  const testHint = status.testFile === null
    ? `write a test for ${sourcePath} first`
    : `run ${status.testFile} and watch it fail first`;

  return {
    gate: "observed-red",
    violations: [
      {
        gate: "observed-red",
        message: `new exported ${newSymbols.length === 1 ? "symbol" : "symbols"} ${names} implemented without an observed failing test — ${status.reason}`,
        fix: `${testHint}. A test that has never been seen to fail proves nothing. Use \`--spike\` for exploratory work.`,
      },
    ],
    overridden: false,
    overrideReasons: [],
  };
}

/**
 * Gate 4 — assertion lint.
 *
 * Fast, in-loop, and about the test as written rather than how it changed.
 *
 * Takes the same override directives as gate 1. They used not to be passed at
 * all, so `keel: allow-test-change <reason>` suppressed a weakening finding but
 * silently did nothing to an assertion-lint block — an escape hatch that is
 * documented, reached for under pressure, and then does not open.
 */
export function gateAssertionLint(
  analysis: TestFileAnalysis,
  overrides: readonly OverrideDirective[] = [],
): GateOutcome {
  if (analysis.unparsed) return clean("assertion-lint");

  const violations: TddViolation[] = [];
  const overrideReasons: string[] = [];
  let overridden = false;

  // Lines that start a test, so an override can be attributed to the test it
  // sits inside rather than only to the declaration line.
  const testLines = analysis.tests.map((t) => t.line).sort((a, b) => a - b);
  const firstTestLine = testLines[0] ?? Number.POSITIVE_INFINITY;

  const appliedOverride = (line: number): OverrideDirective | null => {
    // The declaration line itself, or the comment line directly above it.
    const direct = overrideFor(overrides, line);
    if (direct !== null) return direct;
    // Inside the test's body: everything up to the next test declaration.
    const next = testLines.find((l) => l > line) ?? Number.POSITIVE_INFINITY;
    const inside = overrides.find((o) => o.line >= line && o.line < next);
    if (inside !== undefined) return inside;
    // A header override, above every test, covers the file.
    return overrides.find((o) => o.line <= firstTestLine) ?? null;
  };

  const record = (violation: TddViolation, line: number): void => {
    const applied = appliedOverride(line);
    if (applied !== null) {
      overridden = true;
      overrideReasons.push(applied.reason);
      return;
    }
    violations.push(violation);
  };

  for (const test of analysis.tests) {
    if (test.skipped) continue;
    // A `describe` is not a test. One containing no inner `it` — only a
    // `beforeEach`, or tests registered by a helper — reaches here as a leaf,
    // and linting it produces `test "suite" asserts nothing` about a block
    // that never claimed to assert.
    if (test.suite) continue;

    if (test.assertions === 0) {
      record({
        gate: "assertion-lint",
        line: test.line,
        message: `test "${test.name}" asserts nothing`,
        fix: "assert on the behaviour, or delete the test — a test that cannot fail is worse than no test",
      }, test.line);
      continue;
    }

    const snapshotOnly =
      test.matchers.length > 0 && test.matchers.every((m) => SNAPSHOT_MATCHERS.has(m));
    if (snapshotOnly) {
      record({
        gate: "assertion-lint",
        line: test.line,
        message: `test "${test.name}" asserts only via snapshot`,
        fix: "assert the specific behaviour you care about; a snapshot records whatever the code did, including a bug",
      }, test.line);
      continue;
    }

    const weakOnly = test.matchers.length > 0 && test.matchers.every((m) => WEAK_MATCHERS.has(m));
    if (weakOnly) {
      record({
        gate: "assertion-lint",
        line: test.line,
        message: `test "${test.name}" asserts only truthiness or definedness`,
        fix: "assert the actual value with `toBe`/`toEqual` (or `assertEqual`) so the test can distinguish right from wrong",
      }, test.line);
    }
  }

  return { gate: "assertion-lint", violations, overridden, overrideReasons };
}

/** Render violations for a hook's stderr. */
export function formatViolations(outcomes: readonly GateOutcome[], path: string): string {
  const all = outcomes.flatMap((o) => o.violations);
  if (all.length === 0) return "";

  const lines = ["Keel TDD gate blocked this edit:", ""];
  for (const violation of all) {
    const where = violation.line === undefined ? path : `${path}:${violation.line}`;
    lines.push(`  ${where}  [${violation.gate}]`);
    lines.push(`    ${violation.message}`);
    lines.push(`    fix: ${violation.fix}`);
    lines.push("");
  }
  return lines.join("\n");
}
