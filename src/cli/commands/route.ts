import { loadConfigOrDefaults, type Track } from "../../shared/config.js";
import { stopwatch } from "../../shared/log.js";
import { applyOverride, classify } from "../../router/classify.js";
import { collectSignals } from "../../router/signals.js";
import { record } from "../../telemetry/spool.js";
import { EFFORT_LEVELS, setEffortLevel, type EffortLevel } from "../../shared/settings.js";
import { bold, cyan, dim, heading, info, line, rows } from "../output.js";

/**
 * `keel route` — classify the current change.
 *
 * Prints the track, the effort to use, and the reasons. The reasons matter as
 * much as the answer: a router nobody can argue with is a router nobody trusts.
 */

export interface RouteOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly against?: string | null;
  /** Developer override. Always honoured, always logged, never blocked. */
  readonly override?: Track | null;
  readonly json?: boolean;
  /** Write the track's effort into .claude/settings.local.json. */
  readonly applyEffort?: boolean;
}

export async function route(options: RouteOptions): Promise<number> {
  const { config } = loadConfigOrDefaults(options.repoRoot);
  const timer = stopwatch();

  const signals = await collectSignals(options.repoRoot, config, {
    pluginRoot: options.pluginRoot,
    against: options.against ?? null,
  });

  const routed = classify(signals, config);
  const requested = options.override ?? null;
  const final = requested === null ? routed : applyOverride(routed, requested);
  const ms = timer();

  record(options.repoRoot, config, {
    kind: "route",
    track: final.track,
    ...(final.escalatedFrom === undefined ? {} : { escalated_from: final.escalatedFrom }),
    reason_count: final.reasons.length,
    changed_files: signals.changedFiles.length,
    changed_lines: signals.addedLines + signals.removedLines,
    duration_ms: ms,
  });

  if (requested !== null && requested !== routed.track) {
    record(options.repoRoot, config, {
      kind: "override",
      from: routed.track,
      to: requested,
      direction: requested === "quick" || routed.track === "full" ? "down" : "up",
    });
  }

  const effort = config.tracks[final.track].effort;

  // Plan §"Effort by track": quick -> low, standard -> medium, full -> high.
  // Written to settings.local.json, not the shared project settings: the level
  // follows *this* change's track, which is per-developer and per-branch.
  let applied: string | null = null;
  if (options.applyEffort === true) {
    const level = (EFFORT_LEVELS as readonly string[]).includes(effort)
      ? (effort as EffortLevel)
      : "medium";
    const written = setEffortLevel(options.repoRoot, level);
    applied = written.ok && written.value !== "unreadable" ? level : null;
  }

  if (options.json === true) {
    line(
      JSON.stringify({
        ...final,
        effort,
        durationMs: ms,
        ...(applied === null ? {} : { effortApplied: applied }),
      }),
    );
    return 0;
  }

  heading("Route");
  rows([
    ["track", bold(cyan(final.track))],
    [
      "effort",
      applied === null ? `${effort} ${dim("(not applied — pass --apply-effort)")}` : `${effort} ${dim("→ settings.local.json")}`,
    ],
    ["files", String(signals.changedFiles.length)],
    ["lines", String(signals.addedLines + signals.removedLines)],
    ["took", `${ms.toFixed(0)} ms`],
  ]);

  if (final.reasons.length > 0) {
    heading("Why");
    for (const reason of final.reasons) info(reason);
  }

  if (final.track !== "quick") {
    heading("Process");
    if (final.track === "standard") {
      line("  plan → build (test-first) → verify chain");
    } else {
      line("  OpenSpec proposal → plan → build (test-first) → verify → archive");
      line(dim("  Cap the spec at ~250 lines and attach the delta to the PR."));
    }
  }

  line();
  return 0;
}
