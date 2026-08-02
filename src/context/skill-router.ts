import type { KeelConfig } from "../shared/config.js";
import { guidesFor, renderGuides } from "../standards/context.js";

import { markGuidesLoaded, readSessionState } from "./session-state.js";

/**
 * Path-based skill routing.
 *
 * A `PreToolUse` hook on Write|Edit matches the target path against every
 * guide-mode pack's `applies_to` and returns the relevant guidance as
 * `additionalContext`.
 *
 * Suggest, never force (M4): this attaches context, it never returns a
 * permission decision. A guide that blocks an edit is a gate that was filed in
 * the wrong mode.
 */

export interface SkillRouteResult {
  /** Text for `hookSpecificOutput.additionalContext`, or null when there is nothing new. */
  readonly additionalContext: string | null;
  /** Packs surfaced by this call, for telemetry and the session ledger. */
  readonly packs: readonly string[];
}

export function routeSkills(
  repoRoot: string,
  pluginRoot: string,
  config: KeelConfig,
  filePath: string,
  sessionId: string,
): SkillRouteResult {
  const guides = guidesFor(repoRoot, pluginRoot, config, filePath);
  if (guides.length === 0) return { additionalContext: null, packs: [] };

  const alreadyLoaded = new Set(readSessionState(repoRoot, sessionId).loadedGuides);
  const rendered = renderGuides(guides, alreadyLoaded);
  if (rendered === null) return { additionalContext: null, packs: [] };

  const fresh = guides.filter((g) => !alreadyLoaded.has(g.pack)).map((g) => g.pack);
  markGuidesLoaded(repoRoot, sessionId, fresh);

  return { additionalContext: rendered, packs: fresh };
}
