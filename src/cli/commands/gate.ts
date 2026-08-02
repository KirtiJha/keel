import { loadConfigOrDefaults } from "../../shared/config.js";
import { changedLines, diffSummary, isGitRepo } from "../../shared/git.js";
import { stopwatch } from "../../shared/log.js";
import { applicablePacks, runGates } from "../../standards/runner.js";
import { loadPacks } from "../../standards/loader.js";
import { record } from "../../telemetry/spool.js";
import type { ReportedFinding } from "../../standards/types.js";
import { bold, detail, dim, fail, heading, info, json, line, ok, rows, warn } from "../output.js";

/**
 * `keel gate` — run the standards gates outside the editing loop.
 *
 * Until this existed, `runGates` had exactly one caller: the PostToolUse hook.
 * Standards were therefore enforced only when Claude Code did the editing. A
 * change written in vim, in another editor, or by anyone not using the plugin
 * went through untouched, and CI could not run the gates at all — so the one
 * place a team actually blocks a merge was the one place the gates were absent.
 *
 * Same rules as the hook: diff-only evaluation, `high` severity blocks, a rule
 * that cannot run reports an error and never blocks.
 */

export interface GateOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  /** Base ref. Null compares the working tree against HEAD, as the hook does. */
  readonly against: string | null;
  readonly json: boolean;
  /** Print advisory findings too, not just blocking ones. */
  readonly all: boolean;
}

interface FileOutcome {
  readonly path: string;
  readonly blocking: readonly ReportedFinding[];
  readonly advisory: readonly ReportedFinding[];
  readonly errors: ReadonlyArray<{ readonly pack: string; readonly error: string }>;
  /** Repo-local packs that were not approved to run here. */
  readonly untrusted: readonly string[];
  /** Packs dropped for budget reasons. */
  readonly budgetSkipped: readonly string[];
  /** Set when git could not say which lines changed. */
  readonly skipped: string | null;
}

export async function gate(options: GateOptions): Promise<number> {
  const { config } = loadConfigOrDefaults(options.repoRoot);
  const timer = stopwatch();

  if (!isGitRepo(options.repoRoot)) {
    if (options.json) {
      json({ ok: false, error: "not a git repository", files: [], blocking: 0, advisory: 0 });
    } else {
      fail(`${options.repoRoot} is not a git repository — gates evaluate a diff, and there is none`);
      detail("fix: run `git init` and commit a baseline, or run this inside a checkout");
    }
    return 1;
  }

  const summary = diffSummary(options.repoRoot, options.against);
  const { packs } = loadPacks(options.repoRoot, options.pluginRoot, config);
  const gatePacks = packs.filter((p) => p.standard.mode === "gate");

  const candidates = summary.files.filter(
    (f) => f.status !== "deleted" && applicablePacks(gatePacks, f.path, "gate").length > 0,
  );

  const outcomes: FileOutcome[] = [];

  for (const file of candidates) {
    const resolved = changedLines(options.repoRoot, file.path, options.against);
    if (!resolved.known) {
      // Same contract as the hook: when git cannot say which lines changed we
      // report nothing rather than evaluating the whole file. A gate that fires
      // because git is unavailable is a broken gate.
      outcomes.push({
        path: file.path,
        blocking: [],
        advisory: [],
        errors: [],
        untrusted: [],
        budgetSkipped: [],
        skipped: resolved.reason,
      });
      continue;
    }

    const result = await runGates({
      repoRoot: options.repoRoot,
      pluginRoot: options.pluginRoot,
      config,
      filePath: file.path,
      changedLines: resolved.lines,
    });

    // Same events the hook emits, so `keel doctor`'s hit rates count gates run
    // in CI as well as gates run in an editing session.
    for (const packResult of result.results) {
      record(options.repoRoot, config, {
        kind: "gate",
        pack: packResult.pack,
        severity: packResult.severity,
        result:
          packResult.status !== "ok"
            ? "error"
            : packResult.findings.length === 0
              ? "pass"
              : packResult.severity === "high"
                ? "fail"
                : "warn",
        finding_count: packResult.findings.length,
        duration_ms: packResult.durationMs,
      });
    }

    outcomes.push({
      path: file.path,
      blocking: result.blocking,
      advisory: result.advisory,
      errors: result.results
        .filter((r) => r.status === "error")
        .map((r) => ({ pack: r.pack, error: r.error ?? r.detail ?? "" })),
      untrusted: result.health.untrusted,
      budgetSkipped: result.health.skipped,
      skipped: null,
    });
  }

  const blocking = outcomes.flatMap((o) => o.blocking);
  const advisory = outcomes.flatMap((o) => o.advisory);
  const errors = outcomes.flatMap((o) => o.errors);
  const skipped = outcomes.filter((o) => o.skipped !== null);
  const untrusted = [...new Set(outcomes.flatMap((o) => o.untrusted))];
  const budgetSkipped = [...new Set(outcomes.flatMap((o) => o.budgetSkipped))];
  const ms = timer();

  record(options.repoRoot, config, {
    kind: "hook_timing",
    hook: "cli:gate",
    duration_ms: ms,
    loaded_ast: candidates.length > 0,
  });

  // A gate that did not run must never be reported as a gate that passed. An
  // unapproved repo-local rule is the actionable case — `keel trust add` fixes
  // it — so it fails the run; a rule that will not compile is the pack author's
  // bug and stays non-blocking, matching the hook's fail-open contract.
  const failed = blocking.length > 0 || untrusted.length > 0;

  if (options.json) {
    json({
      ok: !failed,
      against: options.against,
      changedFiles: summary.files.length,
      checkedFiles: candidates.length,
      blocking,
      advisory,
      ruleErrors: errors,
      untrusted,
      budgetSkipped,
      skipped: skipped.map((o) => ({ path: o.path, reason: o.skipped })),
      durationMs: Math.round(ms),
    });
    return failed ? 1 : 0;
  }

  heading("Standards gates");
  rows([
    ["against", options.against ?? dim("working tree vs HEAD")],
    ["changed", `${summary.files.length} file${summary.files.length === 1 ? "" : "s"}`],
    ["checked", `${candidates.length} matched a gate pack`],
    ["packs", gatePacks.length === 0 ? dim("none in gate mode") : String(gatePacks.length)],
    ["took", `${ms.toFixed(0)} ms`],
  ]);

  if (gatePacks.length === 0) {
    heading("Summary");
    warn("no gate-mode standards packs are active, so nothing was checked");
    detail("fix: add a pack with `mode: gate` under standards/, or check `standards.disabled` in keel.config.yaml");
    line();
    return 0;
  }

  if (blocking.length > 0) {
    heading("Blocking");
    for (const finding of blocking) {
      fail(`${finding.path}:${finding.line}${finding.column === undefined ? "" : `:${finding.column}`}  ${dim(`[${finding.pack}]`)}`);
      detail(finding.message);
      detail(`fix: ${finding.fix}`);
    }
  }

  if (advisory.length > 0 && options.all) {
    heading("Advisory");
    for (const finding of advisory) {
      warn(`${finding.path}:${finding.line}  ${dim(`[${finding.pack}]`)}`);
      detail(finding.message);
      detail(`fix: ${finding.fix}`);
    }
  }

  if (untrusted.length > 0) {
    heading("Gates that did not run");
    for (const pack of untrusted) {
      fail(`${pack} is a repo-local rule this checkout has not approved`);
      detail(`fix: read its rule file, then \`keel trust add ${pack}\``);
    }
  }

  if (errors.length > 0) {
    heading("Rules that could not run");
    for (const entry of errors) {
      warn(`${entry.pack}: ${entry.error}`);
      detail("fix: repair the pack's rule file — a broken rule never blocks, so this is invisible otherwise");
    }
  }

  if (budgetSkipped.length > 0) {
    heading("Gates dropped for time");
    for (const pack of budgetSkipped) warn(`${pack} ran out of its per-file budget`);
    detail("fix: narrow the pack's `applies_to`, or make its rule cheaper — a dropped gate is not a passed gate");
  }

  if (skipped.length > 0) {
    heading("Not evaluated");
    for (const entry of skipped) {
      info(`${entry.path} — ${entry.skipped ?? ""}`);
    }
    detail("gates evaluate changed lines only; with no diff there is nothing to judge");
  }

  heading("Summary");
  if (!failed) {
    const extra = advisory.length === 0 ? "" : `, ${advisory.length} advisory`;
    ok(`no blocking findings across ${candidates.length} file${candidates.length === 1 ? "" : "s"}${extra}`);
    if (advisory.length > 0 && !options.all) detail("pass --all to list the advisory findings");
    line();
    return 0;
  }

  if (blocking.length > 0) {
    const files = new Set(blocking.map((f) => f.path)).size;
    fail(
      `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`,
    );
  }
  if (untrusted.length > 0) {
    fail(`${untrusted.length} gate${untrusted.length === 1 ? "" : "s"} did not run for want of approval`);
  }
  line(`  ${bold("Gates evaluate only the lines this change touched.")}`);
  line();
  return 1;
}
