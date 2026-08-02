import { loadConfigOrDefaults, type Track } from "../../shared/config.js";
import { stopwatch } from "../../shared/log.js";
import { applyOverride, classify } from "../../router/classify.js";
import { collectSignals } from "../../router/signals.js";
import { record } from "../../telemetry/spool.js";
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

  if (options.json === true) {
    line(JSON.stringify({ ...final, effort: config.tracks[final.track].effort, durationMs: ms }));
    return 0;
  }

  heading("Route");
  rows([
    ["track", bold(cyan(final.track))],
    ["effort", config.tracks[final.track].effort],
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
