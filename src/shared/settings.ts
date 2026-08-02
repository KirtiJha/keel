import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isFile } from "./paths.js";
import { errorMessage, type Result, err, ok } from "./result.js";

/**
 * Reading and merging Claude Code settings files.
 *
 * Three Keel features write here — the upstream environment, the effort level
 * per track, and skill visibility — so the merge discipline lives in one place
 * rather than being reimplemented three times with three subtly different
 * ideas of what "do not clobber" means.
 *
 * The rules, applied by every writer:
 *
 *  - Merge, never replace. `settings.json` is shared; a key we do not own must
 *    survive untouched.
 *  - Never reverse a deliberate value. If a key is already set, leave it —
 *    someone set it on purpose, and Keel is not the authority on their config.
 *  - A file we cannot parse is a file we do not write. Overwriting a broken
 *    settings.json would destroy whatever the developer was mid-way through.
 */

/** Which settings file. Precedence: local overrides project overrides user. */
export type SettingsScope = "project" | "local";

export function settingsPath(root: string, scope: SettingsScope): string {
  return join(root, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}

export type Settings = Record<string, unknown>;

export interface LoadedSettings {
  readonly settings: Settings;
  readonly existed: boolean;
  /** True when the file exists but could not be parsed. */
  readonly unreadable: boolean;
}

export function readSettings(root: string, scope: SettingsScope): LoadedSettings {
  const path = settingsPath(root, scope);
  if (!isFile(path)) return { settings: {}, existed: false, unreadable: false };

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { settings: {}, existed: true, unreadable: true };
    }
    return { settings: parsed as Settings, existed: true, unreadable: false };
  } catch {
    return { settings: {}, existed: true, unreadable: true };
  }
}

export type WriteOutcome = "created" | "updated" | "unchanged" | "unreadable";

/**
 * Apply `update` to a settings file.
 *
 * `update` receives the current settings and returns the new ones, or null to
 * decline the write. Returning the same object is fine — the outcome is decided
 * by comparing serialised output, so a no-op change writes nothing.
 */
export function updateSettings(
  root: string,
  scope: SettingsScope,
  update: (current: Settings) => Settings | null,
): Result<WriteOutcome, string> {
  const loaded = readSettings(root, scope);
  if (loaded.unreadable) return ok("unreadable");

  const next = update(loaded.settings);
  if (next === null) return ok("unchanged");

  const before = JSON.stringify(loaded.settings);
  const after = JSON.stringify(next);
  if (before === after) return ok("unchanged");

  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath(root, scope), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (cause) {
    return err(errorMessage(cause));
  }

  return ok(loaded.existed ? "updated" : "created");
}

/** Read a nested object-valued key, or an empty object. */
export function objectAt(settings: Settings, key: string): Record<string, unknown> {
  const value = settings[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/**
 * Merge entries into an object-valued key without overwriting existing ones.
 *
 * Returns null when nothing would change, so callers get `unchanged` rather
 * than a rewrite with identical content.
 */
export function mergeObjectKey(
  settings: Settings,
  key: string,
  entries: Readonly<Record<string, unknown>>,
): Settings | null {
  const current = objectAt(settings, key);
  let changed = false;

  for (const [name, value] of Object.entries(entries)) {
    if (current[name] === undefined) {
      current[name] = value;
      changed = true;
    }
  }

  return changed ? { ...settings, [key]: current } : null;
}

/** Effort levels Claude Code accepts for `effortLevel`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Set `effortLevel`.
 *
 * Written to `settings.local.json` rather than `settings.json`: the level
 * follows the *current change's* track, which is a per-developer, per-branch
 * fact. Committing it to the shared project settings would pin the whole team
 * to whatever track the last person happened to be on.
 *
 * Unlike the merge helpers, this deliberately overwrites — the caller is
 * asking to change the level, and refusing because one is already set would
 * make the command a no-op after its first use.
 */
export function setEffortLevel(root: string, level: EffortLevel): Result<WriteOutcome, string> {
  return updateSettings(root, "local", (current) =>
    current["effortLevel"] === level ? null : { ...current, effortLevel: level },
  );
}

export function readEffortLevel(root: string): string | null {
  const value = readSettings(root, "local").settings["effortLevel"];
  return typeof value === "string" ? value : null;
}

/**
 * Skill visibility states, from the `skillOverrides` setting.
 *
 * A skill absent from `skillOverrides` is treated as `"on"`.
 */
export const SKILL_STATES = ["on", "name-only", "user-invocable-only", "off"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

/**
 * Apply skill visibility.
 *
 * **`skillOverrides` does not affect plugin skills** — Claude Code manages
 * those through `/plugin`. That matters here: Superpowers ships as a plugin, so
 * its skills cannot be subset this way. Callers must say so rather than write
 * settings that appear to work and quietly do nothing.
 */
export function setSkillOverrides(
  root: string,
  overrides: Readonly<Record<string, SkillState>>,
  scope: SettingsScope = "local",
): Result<WriteOutcome, string> {
  if (Object.keys(overrides).length === 0) return ok("unchanged");

  return updateSettings(root, scope, (current) => {
    const existing = objectAt(current, "skillOverrides");
    let changed = false;
    for (const [name, state] of Object.entries(overrides)) {
      if (existing[name] !== state) {
        existing[name] = state;
        changed = true;
      }
    }
    return changed ? { ...current, skillOverrides: existing } : null;
  });
}

export function readSkillOverrides(
  root: string,
  scope: SettingsScope = "local",
): Record<string, unknown> {
  return objectAt(readSettings(root, scope).settings, "skillOverrides");
}
