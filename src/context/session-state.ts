import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { keelSubdir } from "../shared/paths.js";

/**
 * Per-session scratch state.
 *
 * Holds the two things a hook needs to remember across tool calls within one
 * session: which guides have already been surfaced (so the same standard is not
 * repeated on every edit), and whether the session is a spike.
 *
 * Deliberately not durable. A lost session file costs one duplicated guide,
 * which is why every function here degrades silently instead of throwing.
 */

export interface SessionState {
  /** Guide-mode pack names already sent as additionalContext. */
  readonly loadedGuides: readonly string[];
  /** `--spike` relaxes TDD gates 1 and 3 and is recorded in telemetry. */
  readonly spike: boolean;
}

const EMPTY: SessionState = { loadedGuides: [], spike: false };

function sanitise(sessionId: string): string {
  // Session ids come from hook stdin; never let one escape the state directory.
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}

function statePath(root: string, sessionId: string): string {
  return join(keelSubdir(root, "state"), `session-${sanitise(sessionId)}.json`);
}

export function readSessionState(root: string, sessionId: string): SessionState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(root, sessionId), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const record = parsed as Partial<SessionState>;
    return {
      loadedGuides: Array.isArray(record.loadedGuides)
        ? record.loadedGuides.filter((g): g is string => typeof g === "string")
        : [],
      spike: record.spike === true,
    };
  } catch {
    return EMPTY;
  }
}

export function writeSessionState(root: string, sessionId: string, state: SessionState): void {
  try {
    mkdirSync(keelSubdir(root, "state"), { recursive: true });
    writeFileSync(statePath(root, sessionId), JSON.stringify(state), "utf8");
  } catch {
    // Losing session state is a cosmetic problem, never a blocking one.
  }
}

export function updateSessionState(
  root: string,
  sessionId: string,
  update: (current: SessionState) => SessionState,
): SessionState {
  const next = update(readSessionState(root, sessionId));
  writeSessionState(root, sessionId, next);
  return next;
}

export function markGuidesLoaded(root: string, sessionId: string, packs: readonly string[]): void {
  if (packs.length === 0) return;
  updateSessionState(root, sessionId, (current) => ({
    ...current,
    loadedGuides: [...new Set([...current.loadedGuides, ...packs])],
  }));
}

export function setSpike(root: string, sessionId: string, spike: boolean): void {
  updateSessionState(root, sessionId, (current) => ({ ...current, spike }));
}

/** Spike mode, from session state or the environment escape hatch. */
export function isSpike(root: string, sessionId: string): boolean {
  const env = process.env["KEEL_SPIKE"];
  if (env !== undefined && env !== "" && env !== "0" && env !== "false") return true;
  return readSessionState(root, sessionId).spike;
}
