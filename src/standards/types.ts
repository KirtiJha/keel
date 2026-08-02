import type { ParsedSource } from "../shared/ast/ts.js";

/**
 * The contract a standards pack rule is written against.
 *
 * Kept deliberately small. A rule sees one file, the lines this change touched,
 * its own configuration, and an AST if one is available. It cannot read other
 * files, run commands, or reach the network — so a pack authored by any team
 * cannot slow down or destabilise everyone else's edits.
 */

export interface Finding {
  /** 1-based line in the file being checked. */
  readonly line: number;
  /** 1-based column. Optional; defaults to 1 when reporting. */
  readonly column?: number;
  /** What is wrong. One sentence, no rule name — the runner adds that. */
  readonly message: string;
  /** What to do instead. Concrete: the point is that nobody has to ask. */
  readonly fix: string;
}

export interface GateContext {
  /** Repo-relative path with POSIX separators. */
  readonly path: string;
  /** Full text of the file. Rules read context but may only report on changed lines. */
  readonly source: string;
  /**
   * 1-based line numbers this change touched.
   *
   * Rules may consult this, but they do not have to: the runner drops any
   * finding outside the set regardless. Diff-only is a property of the runner,
   * not a courtesy each pack has to remember (build spec M4).
   */
  readonly changedLines: ReadonlySet<number>;
  /** Free-form `config:` block from the pack's standard.yaml. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Parsed TS/JS AST, or null for other languages or an unavailable compiler. */
  readonly ast: ParsedSource | null;
}

export type Rule = (context: GateContext) => Finding[] | Promise<Finding[]>;

export type { PackMode, Severity } from "./schema.js";
import type { Severity } from "./schema.js";

export interface GateResult {
  readonly pack: string;
  readonly severity: Severity;
  readonly findings: readonly ReportedFinding[];
  readonly durationMs: number;
  /** Set when the rule itself failed. Never blocks; logged and reported. */
  readonly error?: string;
}

export interface ReportedFinding extends Finding {
  readonly pack: string;
  readonly severity: Severity;
  readonly path: string;
}

/** Aggregated outcome for one file across every applicable pack. */
export interface GateRunSummary {
  readonly path: string;
  readonly results: readonly GateResult[];
  /** Findings at `severity: high` — these block with exit 2. */
  readonly blocking: readonly ReportedFinding[];
  /** `medium` and `low` — reported, never blocking. */
  readonly advisory: readonly ReportedFinding[];
  readonly durationMs: number;
}
