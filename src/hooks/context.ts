import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { KeelConfig } from "../shared/config.js";
import { loadConfigOrDefaults } from "../shared/config.js";
import { type HookInput, hookRoot } from "../shared/hook-io.js";
import { logDebug } from "../shared/log.js";
import { record } from "../telemetry/spool.js";
import type { TelemetryEventInput } from "../telemetry/events.js";

/**
 * Shared setup for every hook: where the repo is, where the plugin is, and a
 * config that is always usable even when the file on disk is not.
 */

export interface HookContext {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly config: KeelConfig;
  readonly configPresent: boolean;
  readonly sessionId: string;
  readonly input: HookInput;
}

/**
 * The plugin checkout root.
 *
 * `CLAUDE_PLUGIN_ROOT` is set by Claude Code when hooks are registered through
 * a plugin. Falling back to the bundle's own location keeps the CLI and the
 * tests working outside that context.
 */
export function pluginRoot(): string {
  const fromEnv = process.env["CLAUDE_PLUGIN_ROOT"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    // scripts/<hook>.mjs -> plugin root is one level up.
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return process.cwd();
  }
}

export function hookContext(input: HookInput): HookContext {
  const repoRoot = hookRoot(input);
  // Fail safe at runtime (constraint 0.9): the coercing reader always returns
  // a usable config. Strict validation is `keel check`'s job, and SessionStart
  // reports it once per session.
  const resolved = loadConfigOrDefaults(repoRoot);
  if (!resolved.present) logDebug("no keel.config.yaml, using defaults");

  return {
    repoRoot,
    pluginRoot: pluginRoot(),
    config: resolved.config,
    configPresent: resolved.present,
    sessionId: typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : "default",
    input,
  };
}

/** Record telemetry, swallowing anything that goes wrong. */
export function emit(context: HookContext, event: TelemetryEventInput): void {
  record(context.repoRoot, context.config, event);
}
