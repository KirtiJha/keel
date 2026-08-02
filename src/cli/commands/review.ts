import { loadConfigOrDefaults, type Track } from "../../shared/config.js";
import { currentBranch, diffSummary, isGitRepo } from "../../shared/git.js";
import { renderRubrics, rubricsFor } from "../../standards/context.js";
import { deltaFor, renderDelta } from "../../spec/delta.js";
import { proposalForBranch } from "../../spec/discover.js";
import { record } from "../../telemetry/spool.js";
import { bold, detail, dim, fail, heading, info, line, ok, rows } from "../output.js";

/**
 * `keel review` — assemble the review chain's input.
 *
 * The chain itself is Claude Code's: `/code-review`, `/simplify`,
 * `/security-review`, `/verify`, plus managed Code Review on the PR. Keel does
 * not reimplement any of them (rule 7 puts review with the built-ins and our
 * rubric). What Keel contributes is the *input*: which rubrics apply to the
 * paths this change touches, and the spec delta if there is one.
 *
 * Filtering matters. A review prompt carrying every rubric the org owns is a
 * prompt the model skims.
 */

export interface ReviewOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly against: string | null;
  readonly track: Track | null;
  /** Emit only the assembled prompt, for piping into a command or agent. */
  readonly promptOnly: boolean;
}

/** The order the chain runs in, and why. */
const CHAIN: ReadonlyArray<readonly [string, string]> = [
  ["/code-review", "correctness first, while the diff is still small"],
  ["/simplify", "then reuse and altitude — after it is correct, not before"],
  ["/security-review", "on full-track changes, or anything touching auth or data"],
  ["/verify", "last: it is the gate, not the review"],
];

export function review(options: ReviewOptions): number {
  const { config } = loadConfigOrDefaults(options.repoRoot);

  if (!isGitRepo(options.repoRoot)) {
    fail("not a git repository — the review chain works from the diff");
    return 1;
  }

  const summary = diffSummary(options.repoRoot, options.against);
  const paths = summary.files.map((f) => f.path);

  if (paths.length === 0) {
    info("no changes to review");
    line();
    return 0;
  }

  const entries = rubricsFor(options.repoRoot, options.pluginRoot, config, paths);
  const branch = currentBranch(options.repoRoot);
  const proposal = proposalForBranch(options.repoRoot, config, branch);

  // ---- prompt-only: pure stdout for piping ----
  if (options.promptOnly) {
    const parts: string[] = [];
    const rubric = renderRubrics(entries);
    if (rubric !== "") parts.push(rubric);

    if (proposal !== null) {
      parts.push(renderDelta(proposal, deltaFor(options.repoRoot, proposal)));
    }

    parts.push("# Diff under review");
    parts.push("");
    parts.push(`${paths.length} file${paths.length === 1 ? "" : "s"}, +${summary.addedLines}/-${summary.removedLines}`);
    parts.push("");
    for (const path of paths.slice(0, 50)) parts.push(`- ${path}`);
    if (paths.length > 50) parts.push(`- …and ${paths.length - 50} more`);

    process.stdout.write(`${parts.join("\n")}\n`);
    return 0;
  }

  // ---- human-facing ----
  heading("Review input");
  rows([
    ["files", String(paths.length)],
    ["lines", `+${summary.addedLines}/-${summary.removedLines}`],
    ["rubrics", entries.length === 0 ? dim("none apply to these paths") : String(entries.length)],
    ["proposal", proposal === null ? dim("none") : proposal.id],
  ]);

  if (entries.length > 0) {
    heading("Rubrics that apply");
    for (const entry of entries) {
      ok(`${entry.pack} — ${entry.description}`);
      detail(`touched: ${entry.paths.slice(0, 4).join(", ")}`);
    }
  } else {
    heading("Rubrics");
    info("no review-mode packs match these paths");
    detail("review-mode packs carry a rubric.md; see the keel-standards skill");
  }

  heading("Chain");
  for (const [command, why] of CHAIN) {
    line(`  ${bold(command.padEnd(18))}${dim(why)}`);
  }
  line();
  line(`  ${dim("Pipe the assembled input into a reviewer with:")}`);
  line("  keel review --prompt | claude -p 'Review this change against the rubric'");
  line(`  ${dim("or use the keel-reviewer subagent, which reads it itself.")}`);
  line();

  return 0;
}

export interface RecordReviewOptions {
  readonly repoRoot: string;
  readonly humanComments: number;
  readonly botComments: number;
  readonly reviewCount: number;
  readonly changedFiles: number;
  readonly track: Track;
}

/**
 * `keel review record` — capture a PR's comment counts.
 *
 * The plan's headline success metric is "human PR comments down 40%", which
 * needs the number recorded somewhere. Counts only: no bodies, no authors, no
 * titles. Called from CI, where the PR API is reachable — never from a hook,
 * because hooks make no network calls.
 */
export function recordReview(options: RecordReviewOptions): number {
  const { config } = loadConfigOrDefaults(options.repoRoot);

  record(options.repoRoot, config, {
    kind: "pr_review",
    human_comments: options.humanComments,
    bot_comments: options.botComments,
    review_count: options.reviewCount,
    changed_files: options.changedFiles,
    track: options.track,
  });

  heading("Recorded");
  rows([
    ["human comments", String(options.humanComments)],
    ["bot comments", String(options.botComments)],
    ["reviews", String(options.reviewCount)],
    ["track", options.track],
  ]);
  line();
  return 0;
}
