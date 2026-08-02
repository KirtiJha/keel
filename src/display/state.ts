import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Track } from "../shared/config.js";
import { keelSubdir } from "../shared/paths.js";

/**
 * The one small state read the MessageDisplay formatter is allowed (M8).
 *
 * Hooks write here as they run; the formatter reads it to fill the `verified`
 * row. Keeping it to a single tiny JSON file is what keeps the formatter inside
 * its 100 ms budget — anything that needed git or a parse would not fit.
 */

export interface VerifyCheck {
  readonly label: string;
  readonly ok: boolean;
  /** Optional detail, e.g. "12/12". */
  readonly detail?: string;
}

export interface DisplayState {
  readonly changedFiles: readonly string[];
  readonly checks: readonly VerifyCheck[];
  readonly track?: Track;
  readonly updatedAt: number;
}

const EMPTY: DisplayState = { changedFiles: [], checks: [], updatedAt: 0 };

/** Beyond this the state is from an earlier task and would mislead. */
const STALE_MS = 30 * 60 * 1000;

function path(root: string): string {
  return join(keelSubdir(root, "state"), "display.json");
}

export function readDisplayState(root: string): DisplayState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path(root), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const state = parsed as Partial<DisplayState>;
    const updatedAt = typeof state.updatedAt === "number" ? state.updatedAt : 0;
    if (Date.now() - updatedAt > STALE_MS) return EMPTY;
    return {
      changedFiles: Array.isArray(state.changedFiles)
        ? state.changedFiles.filter((f): f is string => typeof f === "string")
        : [],
      checks: Array.isArray(state.checks) ? (state.checks as VerifyCheck[]) : [],
      ...(state.track === undefined ? {} : { track: state.track }),
      updatedAt,
    };
  } catch {
    return EMPTY;
  }
}

export function writeDisplayState(root: string, state: Omit<DisplayState, "updatedAt">): void {
  try {
    mkdirSync(keelSubdir(root, "state"), { recursive: true });
    writeFileSync(path(root), JSON.stringify({ ...state, updatedAt: Date.now() }), "utf8");
  } catch {
    // Display state is cosmetic; losing it costs one less-informative row.
  }
}

/** Merge a file into the changed list and record a check outcome. */
export function recordCheck(
  root: string,
  file: string | null,
  check: VerifyCheck | null,
  track?: Track,
): void {
  const current = readDisplayState(root);
  const changedFiles = file === null
    ? current.changedFiles
    : [...new Set([...current.changedFiles, file])].slice(-12);

  const checks = check === null
    ? current.checks
    : [...current.checks.filter((c) => c.label !== check.label), check];

  writeDisplayState(root, {
    changedFiles,
    checks,
    ...(track === undefined ? (current.track === undefined ? {} : { track: current.track }) : { track }),
  });
}

/** Clear at the start of a new task so rows never carry over. */
export function resetDisplayState(root: string): void {
  writeDisplayState(root, { changedFiles: [], checks: [] });
}
