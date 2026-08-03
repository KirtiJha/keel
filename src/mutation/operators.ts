/**
 * Mutation operators.
 *
 * Plan: "Mutation testing (CI, diff-only): gate on mutation score, never on
 * line coverage. Coverage targets produce tests that execute code without
 * checking anything." This is also the stated catcher for TDD failure mode 4 —
 * tautological assertions — which review and assertion lint cannot see.
 *
 * A mutant is a single textual edit at an AST-verified position. Keeping the
 * representation to `(start, end, replacement)` is what lets one runner drive
 * both languages: TypeScript positions come from the compiler API, Python
 * positions from the stdlib `ast`, and neither needs its own execution path.
 *
 * The operator set is the classic, well-understood one. Deliberately small:
 * every operator has to be worth the CI minutes it costs, and exotic mutants
 * mostly produce equivalent code that no test could kill.
 */

export type OperatorName =
  | "conditional-boundary"
  | "negate-conditional"
  | "arithmetic"
  | "logical"
  | "boolean-literal"
  | "return-value"
  | "string-literal"
  | "increment";

export interface Mutant {
  /** Repo-relative path, POSIX. */
  readonly file: string;
  /** 1-based line, used for the diff-only filter and for reporting. */
  readonly line: number;
  readonly operator: OperatorName;
  /** Character offset range in the original source. */
  readonly start: number;
  readonly end: number;
  /** Text that replaces [start, end). */
  readonly replacement: string;
  /** Original text, for the report. */
  readonly original: string;
}

/** Binary operators and what they become. Shared by both languages. */
export const BINARY_MUTATIONS: Readonly<Record<string, { to: string; operator: OperatorName }>> = {
  // Boundary: the classic off-by-one detector.
  "<": { to: "<=", operator: "conditional-boundary" },
  "<=": { to: "<", operator: "conditional-boundary" },
  ">": { to: ">=", operator: "conditional-boundary" },
  ">=": { to: ">", operator: "conditional-boundary" },

  // Equality: a test that cannot tell these apart is not testing behaviour.
  "===": { to: "!==", operator: "negate-conditional" },
  "!==": { to: "===", operator: "negate-conditional" },
  "==": { to: "!=", operator: "negate-conditional" },
  "!=": { to: "==", operator: "negate-conditional" },

  // Arithmetic.
  "+": { to: "-", operator: "arithmetic" },
  "-": { to: "+", operator: "arithmetic" },
  "*": { to: "/", operator: "arithmetic" },
  "/": { to: "*", operator: "arithmetic" },
  "%": { to: "*", operator: "arithmetic" },

  // Logical.
  "&&": { to: "||", operator: "logical" },
  "||": { to: "&&", operator: "logical" },
};


/**
 * Deterministic ordering, then a deterministic cap.
 *
 * Mutation runs must be reproducible: the same diff has to produce the same
 * score, or the gate becomes a coin toss and gets switched off. Sorting by
 * position and taking a strided sample keeps the selection spread across the
 * whole change rather than exhausting the first file.
 */
export function selectMutants(mutants: readonly Mutant[], max: number): Mutant[] {
  const sorted = [...mutants].sort(
    (a, b) => a.file.localeCompare(b.file) || a.start - b.start || a.operator.localeCompare(b.operator),
  );
  if (sorted.length <= max) return sorted;

  const stride = sorted.length / max;
  const out: Mutant[] = [];
  for (let i = 0; i < max; i++) {
    const picked = sorted[Math.floor(i * stride)];
    if (picked !== undefined) out.push(picked);
  }
  return out;
}

/** Apply one mutant to source text. */
export function applyMutant(source: string, mutant: Mutant): string {
  return source.slice(0, mutant.start) + mutant.replacement + source.slice(mutant.end);
}
