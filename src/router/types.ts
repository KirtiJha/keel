import type { Track } from "../shared/config.js";

export type { Track };

/**
 * One exported symbol that this change touches.
 *
 * The build spec's `ChangeSignals` carries a flat `externalCallerCount`, but
 * routing rule 2 needs per-symbol detail — it escalates to *full* only when a
 * hot symbol also crosses a package boundary, which an aggregate count cannot
 * express. So the per-symbol record is the real signal and
 * `ChangeSignals.externalCallerCount` is kept as the derived maximum.
 */
export interface ChangedSymbol {
  readonly name: string;
  /** Repo-relative path of the file declaring it. */
  readonly file: string;
  readonly change: "added" | "removed" | "signature-changed";
  /** Distinct files outside the declaring file that reference this name. */
  readonly externalCallers: number;
  /** True when at least one caller lives under a different package root. */
  readonly crossesPackageBoundary: boolean;
}

export interface ChangeSignals {
  readonly changedFiles: readonly string[];
  readonly addedLines: number;
  readonly removedLines: number;
  readonly changedExportedSymbols: readonly ChangedSymbol[];
  /** Derived: the highest external-caller count across changed symbols. */
  readonly externalCallerCount: number;
}

export interface RouteResult {
  readonly track: Track;
  /** Human-readable, shown in the terminal. Ordered most-decisive first. */
  readonly reasons: readonly string[];
  /** Present only when a rule raised the track above its natural level. */
  readonly escalatedFrom?: Track;
}

const ORDER: Readonly<Record<Track, number>> = { quick: 0, standard: 1, full: 2 };

export function trackRank(track: Track): number {
  return ORDER[track];
}

/** The higher of two tracks. The router escalates only — never lowers. */
export function maxTrack(a: Track, b: Track): Track {
  return trackRank(a) >= trackRank(b) ? a : b;
}
