import type { KeelConfig } from "../shared/config.js";
import { matchingGlobs } from "../shared/glob.js";

import { type ChangeSignals, type RouteResult, type Track, maxTrack, trackRank } from "./types.js";

/**
 * Deterministic track classification. Constraint 0.8: a pure function of its
 * input — no I/O, no clock, no LLM. Everything expensive (git, AST, caller
 * counting) happens in `signals.ts` and arrives here as data.
 *
 * Rules run in the order the build spec lists them (M3):
 *   1. any path matches force_full_globs           -> full
 *   2. a changed exported symbol is widely called  -> at least standard,
 *                                                     full if it crosses a package boundary
 *   3. small, single-file, no signature change     -> quick
 *   4. otherwise                                   -> standard
 *
 * Rules 1 and 2 set a *floor*. Rules 3 and 4 pick the natural track. The result
 * is the higher of the two, which is what makes the router escalate-only.
 */
export function classify(signals: ChangeSignals, config: KeelConfig): RouteResult {
  const reasons: string[] = [];

  // An empty change is quick by definition; nothing below would fire anyway.
  if (signals.changedFiles.length === 0) {
    return { track: "quick", reasons: ["no files changed"] };
  }

  // ---- Rule 1: forced paths -------------------------------------------------
  let floor: Track = "quick";
  const forced: string[] = [];
  for (const file of signals.changedFiles) {
    const hits = matchingGlobs(file, config.router.force_full_globs);
    if (hits.length > 0) forced.push(`${file} (matches ${hits[0] ?? ""})`);
  }
  if (forced.length > 0) {
    floor = "full";
    const shown = forced.slice(0, 3).join(", ");
    const more = forced.length > 3 ? ` and ${forced.length - 3} more` : "";
    reasons.push(`force-full path: ${shown}${more}`);
  }

  // ---- Rule 2: widely-called exported symbols -------------------------------
  const threshold = config.router.escalate_caller_threshold;
  const hot = signals.changedExportedSymbols.filter((s) => s.externalCallers > threshold);
  if (hot.length > 0) {
    const crossing = hot.filter((s) => s.crossesPackageBoundary);
    if (crossing.length > 0) {
      floor = maxTrack(floor, "full");
      const s = crossing[0];
      reasons.push(
        `exported ${s?.name ?? "symbol"} changed with ${s?.externalCallers ?? 0} external callers across a package boundary`,
      );
    } else {
      floor = maxTrack(floor, "standard");
      const s = hot[0];
      reasons.push(
        `exported ${s?.name ?? "symbol"} changed with ${s?.externalCallers ?? 0} external callers (threshold ${threshold})`,
      );
    }
  }

  // ---- Rules 3 and 4: natural track ----------------------------------------
  const fileCount = signals.changedFiles.length;
  const lineCount = signals.addedLines + signals.removedLines;
  const signatureChanged = signals.changedExportedSymbols.length > 0;

  let natural: Track;
  const naturalReasons: string[] = [];

  if (
    fileCount <= config.router.quick_max_files &&
    lineCount <= config.router.quick_max_lines &&
    !signatureChanged
  ) {
    natural = "quick";
    naturalReasons.push(
      `${fileCount} file${fileCount === 1 ? "" : "s"}, ${lineCount} line${lineCount === 1 ? "" : "s"}, no exported signature change`,
    );
  } else {
    natural = "standard";
    if (fileCount > config.router.quick_max_files) {
      naturalReasons.push(`${fileCount} files changed (quick allows ${config.router.quick_max_files})`);
    }
    if (lineCount > config.router.quick_max_lines) {
      naturalReasons.push(`${lineCount} lines changed (quick allows ${config.router.quick_max_lines})`);
    }
    if (signatureChanged) {
      const names = signals.changedExportedSymbols.slice(0, 3).map((s) => s.name).join(", ");
      naturalReasons.push(`exported signature changed: ${names}`);
    }
  }

  // ---- Combine --------------------------------------------------------------
  const track = maxTrack(floor, natural);
  const allReasons = [...reasons, ...naturalReasons];

  if (trackRank(floor) > trackRank(natural)) {
    return { track, reasons: allReasons, escalatedFrom: natural };
  }
  return { track, reasons: allReasons };
}

/**
 * Apply a developer override. Escalate-only is a router property, not a policy:
 * a human may lower the track, and the caller logs it. Never blocked.
 */
export function applyOverride(result: RouteResult, requested: Track): RouteResult {
  if (requested === result.track) return result;
  const direction = trackRank(requested) < trackRank(result.track) ? "lowered" : "raised";
  return {
    track: requested,
    reasons: [`developer ${direction} track to ${requested} (router said ${result.track})`, ...result.reasons],
    escalatedFrom: result.track,
  };
}
