import { loadConfigOrDefaults, type Track } from "../../shared/config.js";
import { currentBranch, diffSummary, isGitRepo } from "../../shared/git.js";
import { renderRubrics, rubricsFor } from "../../standards/context.js";
import { deltaFor, renderDelta } from "../../spec/delta.js";
import { proposalForBranch } from "../../spec/discover.js";
import { record } from "../../telemetry/spool.js";
import { assembleDiff } from "../diff-text.js";
import { countRequirements, withRequirementCounts } from "../spec-counts.js";
import { bold, detail, dim, fail, heading, info, json, line, ok, rows } from "../output.js";

/**
 * `keel review` — assemble the review chain's input.
 *
 * The chain itself is Claude Code's: `/code-review`, `/simplify`,
 * `/security-review`, `/verify`, plus managed Code Review on the PR. Keel does
 * not reimplement any of them (rule 7 puts review with the built-ins and our
 * rubric). What Keel contributes is the *input*: which rubrics apply to the
 * paths this change touches, the spec delta if there is one, and the diff.
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
  readonly json?: boolean;
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
  const asJson = options.json === true;

  if (!isGitRepo(options.repoRoot)) {
    if (asJson) {
      json({ ok: false, error: "not a git repository — the review chain works from the diff" });
    } else {
      fail("not a git repository — the review chain works from the diff");
      detail("fix: run `git init` and commit a baseline, or run this inside a checkout");
    }
    return 1;
  }

  const summary = diffSummary(options.repoRoot, options.against);
  const paths = summary.files.map((f) => f.path);

  if (paths.length === 0) {
    if (asJson) {
      json({ ok: true, files: [], rubrics: [], proposal: null, note: "no changes to review" });
      return 0;
    }
    info("no changes to review");
    line();
    return 0;
  }

  const entries = rubricsFor(options.repoRoot, options.pluginRoot, config, paths);
  const branch = currentBranch(options.repoRoot);
  const proposal = proposalForBranch(options.repoRoot, config, branch);
  const sections = proposal === null ? [] : deltaFor(options.repoRoot, proposal);

  // ---- prompt-only: pure stdout for piping ----
  if (options.promptOnly) {
    const parts: string[] = [];
    const rubric = renderRubrics(entries);
    if (rubric !== "") parts.push(rubric);

    if (proposal !== null) {
      parts.push(withRequirementCounts(renderDelta(proposal, sections), sections));
    }

    // The suggested pipeline is
    // `keel review --prompt | claude -p 'Review this change against the rubric'`.
    // It used to emit this heading followed by a *file list*, which hands a
    // reviewer filenames and nothing to review.
    const untracked = summary.files.filter((f) => f.status === "untracked").map((f) => f.path);
    const patch = assembleDiff(options.repoRoot, options.against, untracked);

    parts.push("# Diff under review");
    parts.push("");
    parts.push(
      `${paths.length} file${paths.length === 1 ? "" : "s"}, +${summary.addedLines}/-${summary.removedLines}` +
        `${options.against === null ? " (working tree vs HEAD)" : ` (${options.against}...HEAD)`}`,
    );
    parts.push("");

    if (patch.text.trim() === "") {
      parts.push("_The diff could not be read._ Files in this change:");
      parts.push("");
      for (const path of paths.slice(0, 50)) parts.push(`- ${path}`);
      if (paths.length > 50) parts.push(`- …and ${paths.length - 50} more`);
    } else {
      parts.push("```diff");
      parts.push(patch.text);
      parts.push("```");
      if (patch.truncated) {
        parts.push("");
        parts.push(
          `_Diff truncated to fit the prompt._${patch.omittedFiles.length === 0 ? "" : ` Patches omitted for: ${patch.omittedFiles.slice(0, 20).join(", ")}${patch.omittedFiles.length > 20 ? `, and ${patch.omittedFiles.length - 20} more` : ""}.`} Read the rest with \`git diff${options.against === null ? "" : ` ${options.against}...HEAD`}\`.`,
        );
      }
    }

    process.stdout.write(`${parts.join("\n")}\n`);
    return 0;
  }

  if (asJson) {
    json({
      ok: true,
      against: options.against,
      track: options.track,
      files: paths,
      addedLines: summary.addedLines,
      removedLines: summary.removedLines,
      rubrics: entries.map((e) => ({ pack: e.pack, description: e.description, paths: e.paths })),
      proposal:
        proposal === null
          ? null
          : { id: proposal.id, requirements: countRequirements(sections).total, sections: sections.length },
      chain: CHAIN.map(([command, why]) => ({ command, why })),
    });
    return 0;
  }

  // ---- human-facing ----
  heading("Review input");
  rows([
    ["files", String(paths.length)],
    ["lines", `+${summary.addedLines}/-${summary.removedLines}`],
    ["rubrics", entries.length === 0 ? dim("none apply to these paths") : String(entries.length)],
    [
      "proposal",
      proposal === null
        ? dim("none")
        : `${proposal.id} ${dim(`(${countRequirements(sections).total} requirements)`)}`,
    ],
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
  line(`  ${dim("Pipe the assembled input — rubrics, spec delta and the diff itself — into a reviewer with:")}`);
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
  readonly json?: boolean;
}

/**
 * `keel review record` — capture a PR's comment counts.
 *
 * The plan's headline success metric is "human PR comments down 40%", which
 * needs the number recorded somewhere. Counts only: no bodies, no authors, no
 * titles. Called from CI, where the PR API is reachable — never from a hook,
 * because hooks make no network calls.
 *
 * Non-numeric input is rejected by the caller before it reaches here: a metric
 * that silently records 0 for `--human-comments abc` is worse than no metric.
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

  if (options.json === true) {
    json({
      ok: true,
      humanComments: options.humanComments,
      botComments: options.botComments,
      reviews: options.reviewCount,
      changedFiles: options.changedFiles,
      track: options.track,
    });
    return 0;
  }

  heading("Recorded");
  rows([
    ["human comments", String(options.humanComments)],
    ["bot comments", String(options.botComments)],
    ["reviews", String(options.reviewCount)],
    ["changed files", String(options.changedFiles)],
    ["track", options.track],
  ]);
  line();
  return 0;
}
