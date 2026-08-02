/**
 * The test vocabulary the gates recognise, per framework family.
 *
 * Build spec M6 requires "an explicit downgrade map per framework" rather than
 * a heuristic. An explicit map is checkable, reviewable, and — when it blocks
 * someone — explainable in one line. A strength heuristic is none of those.
 */

/** Callee names that declare a test. */
export const TEST_DECLARATIONS = new Set([
  "it",
  "test",
  "describe",
  "suite",
  "context",
  "bench",
]);

/** Callee names that declare a *skipped* test outright. */
export const SKIPPED_DECLARATIONS = new Set(["xit", "xtest", "xdescribe", "xspecify"]);

/** Callee names that focus a test, excluding its siblings from the run. */
export const FOCUSED_DECLARATIONS = new Set(["fit", "fdescribe", "ftest"]);

/** Modifiers on a test declaration: `it.skip(...)`, `describe.only(...)`. */
export const SKIP_MODIFIERS = new Set(["skip", "todo", "concurrent.skip", "skipIf"]);
export const ONLY_MODIFIERS = new Set(["only", "concurrent.only", "runIf"]);

/**
 * Table-driven modifiers, which are *curried*: `it.each(table)(name, fn)`.
 *
 * The inner call takes the table and the outer call takes the test body, so the
 * declaration is the outer one. Treating the inner call as the test makes every
 * table-driven test look assertion-free — which is exactly the false positive
 * this codebase's own suite caught.
 */
export const EACH_MODIFIERS = new Set(["each", "for", "concurrent.each", "skip.each", "only.each"]);

/** Callee names that start an assertion. */
export const ASSERTION_ROOTS = new Set(["expect", "assert", "should", "chai"]);

/** Module-mocking calls whose first argument is a module specifier. */
export const MOCK_CALLS = new Set([
  "vi.mock",
  "vi.doMock",
  "jest.mock",
  "jest.doMock",
  "jest.unstable_mockModule",
  "mock.module",
]);

/**
 * Matcher downgrades: strong -> the weaker matchers it is commonly replaced by.
 *
 * A downgrade fires only when the strong matcher's count *falls* and one of its
 * weaker counterparts' count *rises* in the same edit. That pairing is what
 * distinguishes "loosened an assertion to get to green" from "wrote a different
 * test that legitimately uses toBeDefined".
 */
export const MATCHER_DOWNGRADES: Readonly<Record<string, readonly string[]>> = {
  toBe: ["toBeTruthy", "toBeFalsy", "toBeDefined", "toBeUndefined", "toBeNull", "toBeCloseTo", "anything"],
  toEqual: ["toMatchObject", "toBeTruthy", "toBeDefined", "toContain", "anything"],
  toStrictEqual: ["toEqual", "toMatchObject", "toBeTruthy", "toBeDefined", "anything"],
  toMatchObject: ["toBeTruthy", "toBeDefined", "anything"],
  toHaveBeenCalledWith: ["toHaveBeenCalled", "toBeTruthy"],
  toHaveBeenCalledTimes: ["toHaveBeenCalled", "toBeTruthy"],
  toThrowError: ["toThrow", "toBeTruthy"],
  toContain: ["toBeTruthy", "toBeDefined"],
  toHaveLength: ["toBeTruthy", "toBeDefined"],
};

/** Python's equivalent, for unittest and pytest style. */
export const PYTHON_MATCHER_DOWNGRADES: Readonly<Record<string, readonly string[]>> = {
  assertEqual: ["assertTrue", "assertIsNotNone", "assertFalse"],
  assertNotEqual: ["assertTrue", "assertIsNotNone"],
  assertIs: ["assertTrue", "assertIsNotNone"],
  assertDictEqual: ["assertTrue", "assertIsNotNone"],
  assertListEqual: ["assertTrue", "assertIsNotNone"],
  assertSetEqual: ["assertTrue", "assertIsNotNone"],
  assertRaises: ["assertTrue"],
  assertAlmostEqual: ["assertTrue", "assertIsNotNone"],
};

/**
 * Matchers that cannot distinguish a correct value from a wrong one.
 *
 * Deliberately narrow. `toBeUndefined` and `toBeNull` look weak but are precise
 * — "this field is absent" is often the exact behaviour under test — and
 * flagging them produces false positives on correct tests, which is how a gate
 * loses its credibility. Only genuinely uninformative matchers belong here:
 * anything truthy satisfies `toBeTruthy`, so it proves nearly nothing.
 *
 * These same matchers still count as *downgrades* in gate 1, where the signal
 * is the replacement of a strong matcher rather than the matcher itself.
 */
export const WEAK_MATCHERS = new Set(["toBeTruthy", "toBeFalsy", "anything", "assertTrue"]);

/** Snapshot matchers, which pass on first run whatever the implementation does. */
export const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toMatchFileSnapshot",
  "matchSnapshot",
]);

/** Comment escape hatch. Logged to telemetry, never silently honoured. */
export const OVERRIDE_MARKER = "keel: allow-test-change";

export interface OverrideDirective {
  readonly line: number;
  readonly reason: string;
}

/**
 * Find `keel: allow-test-change <reason>` comments.
 *
 * A bare marker with no reason does not count: the point of the escape hatch is
 * that someone had to state why, and an unexplained override is exactly the
 * silent weakening the gate exists to catch.
 */
export function findOverrides(source: string): OverrideDirective[] {
  const out: OverrideDirective[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idx = line.indexOf(OVERRIDE_MARKER);
    if (idx < 0) continue;
    const reason = line.slice(idx + OVERRIDE_MARKER.length).replace(/^[\s:—-]+/, "").trim();
    if (reason === "") continue;
    out.push({ line: i + 1, reason });
  }
  return out;
}

/** Does an override cover this line? Applies to the line itself and the one after. */
export function overrideFor(
  overrides: readonly OverrideDirective[],
  line: number,
): OverrideDirective | null {
  return overrides.find((o) => o.line === line || o.line === line - 1) ?? null;
}

/** A file-level override suppresses the whole gate for this edit. */
export function fileOverride(overrides: readonly OverrideDirective[]): OverrideDirective | null {
  return overrides[0] ?? null;
}
