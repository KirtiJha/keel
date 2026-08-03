import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { isDirectory, isFile } from "../shared/paths.js";
import { errorMessage } from "../shared/result.js";
import { objectAt, updateSettings, type Settings } from "../shared/settings.js";

/**
 * Installing Keel's Claude Code components into a repository.
 *
 * **There is no marketplace.** Keel installs from the checkout, via `keel init`.
 * A marketplace is machinery for distributing a plugin to people who do not have
 * the source; the whole point here is that you *do* have the source — you cloned
 * it to get the CLI. Adding a marketplace on top of that is a second
 * distribution channel to keep in sync with the first, and a second thing that
 * can be stale when the first has moved.
 *
 * So `init` writes the same three things a plugin would have contributed,
 * straight into the repository's own `.claude/`:
 *
 *   - **hooks** into `.claude/settings.local.json`
 *   - **skills** into `.claude/skills/<name>/SKILL.md`
 *   - **the output style** into `.claude/output-styles/keel.md`
 *
 * (Subagents are installed separately by `init`, into `.claude/agents/`, because
 * `keel-reviewer` needs `permissionMode` — see the note there.)
 *
 * ## Why hooks go to the *local* settings file
 *
 * A hook command has to name an executable path, and the path to your Keel
 * checkout is yours alone — `/home/ana/src/keel` is not where a teammate put it.
 * `.claude/settings.json` is a committed file; writing a machine-specific
 * absolute path into it would break for everyone but the person who ran `init`,
 * and would churn the file on every clone. `.claude/settings.local.json` is the
 * per-developer scope Claude Code already provides for exactly this, and it
 * takes precedence over the project file. `init` makes sure it is gitignored.
 *
 * The consequence is honest and worth stating: **every developer runs `keel
 * init` once in the repo.** The config, CLAUDE.md and packs are shared through
 * git; the wiring that points at your own checkout is not.
 *
 * ## Why `hooks/hooks.json` is still the source of truth
 *
 * The hook set is defined once, in `hooks/hooks.json`, and this module reads it
 * and rewrites the paths. Retyping the event list here would be a second copy to
 * forget to update — which is the failure this codebase has had more than once.
 */

/** Marker recorded alongside the hooks, so a later run knows what it owns. */
export const KEEL_HOOK_MARKER = "keel";

export interface InstalledComponents {
  readonly hooks: number;
  readonly skills: readonly string[];
  readonly outputStyle: boolean;
  readonly problems: readonly string[];
}

interface HookCommand {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly [key: string]: unknown;
}

interface HookMatcher {
  readonly matcher?: string;
  readonly hooks?: readonly HookCommand[];
  readonly [key: string]: unknown;
}

/**
 * Read the plugin's hook definitions with `${CLAUDE_PLUGIN_ROOT}` resolved.
 *
 * Claude Code expands that variable for a *plugin*; nothing expands it in a
 * settings file, so the absolute path is substituted here.
 */
export function hookDefinitions(
  pluginRoot: string,
): { readonly events: Record<string, HookMatcher[]> } | { readonly error: string } {
  const path = join(pluginRoot, "hooks", "hooks.json");
  if (!isFile(path)) return { error: `no hook definitions at ${path}` };

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const hooks = objectAt(parsed as Settings, "hooks");
    const events: Record<string, HookMatcher[]> = {};

    for (const [event, value] of Object.entries(hooks)) {
      if (!Array.isArray(value)) continue;
      events[event] = (value as HookMatcher[]).map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).map((command) => ({
          ...command,
          args: (command.args ?? []).map((arg) =>
            arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot),
          ),
        })),
      }));
    }

    return { events };
  } catch (cause) {
    return { error: `${path} is not valid JSON: ${errorMessage(cause)}` };
  }
}

/** Does this entry belong to Keel — i.e. does it run a script from this checkout? */
function isKeelEntry(entry: HookMatcher, pluginRoot: string): boolean {
  const scripts = resolve(pluginRoot, "scripts");
  return (entry.hooks ?? []).some((command) =>
    (command.args ?? []).some((arg) => resolve(arg).startsWith(scripts)),
  );
}

/**
 * Merge Keel's hooks into the local settings file.
 *
 * Idempotent by replacement rather than by append: Keel's own entries for an
 * event are dropped and rewritten, so running `init` twice leaves one copy and
 * running it after an upgrade picks up a changed hook set. Entries that are not
 * Keel's are never touched — a developer's own PostToolUse hook survives.
 */
export function installHooks(
  repoRoot: string,
  pluginRoot: string,
): { readonly count: number; readonly error: string | null } {
  const definitions = hookDefinitions(pluginRoot);
  if ("error" in definitions) return { count: 0, error: definitions.error };

  let count = 0;
  const written = updateSettings(repoRoot, "local", (current) => {
    const hooks = objectAt(current, "hooks");
    const next: Record<string, unknown> = { ...hooks };

    for (const [event, entries] of Object.entries(definitions.events)) {
      const existing = Array.isArray(next[event]) ? (next[event] as HookMatcher[]) : [];
      const theirs = existing.filter((entry) => !isKeelEntry(entry, pluginRoot));
      next[event] = [...theirs, ...entries];
      count += entries.length;
    }

    return { ...current, hooks: next };
  });

  if (!written.ok) return { count: 0, error: written.error };
  return { count, error: null };
}

/** Copy a file unless the destination exists and differs — a hand edit wins. */
function installFile(from: string, to: string): boolean {
  if (isFile(to)) return false;
  try {
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install skills into `.claude/skills/`.
 *
 * Project skills are discovered by directory presence — nothing registers them —
 * so a copy is the whole installation. A skill a human has edited is left alone,
 * the same rule CLAUDE.md and the subagent template follow.
 */
export function installSkills(repoRoot: string, pluginRoot: string): string[] {
  const source = join(pluginRoot, "skills");
  if (!isDirectory(source)) return [];

  const installed: string[] = [];
  try {
    for (const name of readdirSync(source)) {
      const from = join(source, name, "SKILL.md");
      if (!isFile(from)) continue;
      if (installFile(from, join(repoRoot, ".claude", "skills", name, "SKILL.md"))) {
        installed.push(name);
      }
    }
  } catch {
    return installed;
  }
  return installed;
}

/**
 * Install the output style, without selecting it.
 *
 * Making it *available* is installation; making it *active* is a preference, and
 * this codebase does not reverse a deliberate choice someone else made. `init`
 * says how to turn it on.
 */
export function installOutputStyle(repoRoot: string, pluginRoot: string): boolean {
  const from = join(pluginRoot, "output-styles", "keel.md");
  if (!isFile(from)) return false;
  return installFile(from, join(repoRoot, ".claude", "output-styles", "keel.md"));
}

/** Everything a plugin would have contributed, installed from the checkout. */
export function installComponents(repoRoot: string, pluginRoot: string): InstalledComponents {
  const problems: string[] = [];

  const hooks = installHooks(repoRoot, pluginRoot);
  if (hooks.error !== null) problems.push(`hooks: ${hooks.error}`);

  return {
    hooks: hooks.count,
    skills: installSkills(repoRoot, pluginRoot),
    outputStyle: installOutputStyle(repoRoot, pluginRoot),
    problems,
  };
}
