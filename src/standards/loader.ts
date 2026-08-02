import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { DEFAULT_PACK_DIRS, type KeelConfig } from "../shared/config.js";
import { validateGlob } from "../shared/glob.js";
import { logDebug, logWarn } from "../shared/log.js";
import { isDirectory, isFile, resolveConfiguredPath } from "../shared/paths.js";
import { errorMessage } from "../shared/result.js";

import { parseStandard, type Standard, type StandardIssue } from "./schema.js";

export interface LoadedPack {
  readonly standard: Standard;
  /** Absolute path to the pack directory. */
  readonly dir: string;
  /** Which search root it came from, for `keel doctor` and override logging. */
  readonly origin: string;
  readonly ruleTsPath: string | null;
  readonly rulePyPath: string | null;
  readonly guidePath: string | null;
  readonly rubricPath: string | null;
}

export interface PackIssue extends StandardIssue {
  /** Pack directory the issue came from. */
  readonly pack: string;
  readonly severity: "error" | "warning";
}

export interface PackOverride {
  readonly name: string;
  readonly winner: string;
  readonly loser: string;
}

export interface PackLoadResult {
  readonly packs: readonly LoadedPack[];
  readonly issues: readonly PackIssue[];
  readonly overrides: readonly PackOverride[];
  /** Packs present but switched off via `standards.disabled`. */
  readonly disabled: readonly string[];
}

interface ResolvedRoots {
  readonly roots: string[];
  /** Configured entries that pointed outside the repo, already phrased. */
  readonly rejected: string[];
}

/**
 * Search roots in ascending precedence: the plugin's own packs first, then each
 * configured directory. A repo-local pack with the same name as an org pack
 * wins, and the override is recorded so `keel check` can report it — silent
 * shadowing is how a team ends up running a rule they think they replaced.
 *
 * `standards.dirs` comes out of `keel.config.yaml`, which is committed — so it
 * is repo-supplied input, and it used to be resolved unconditionally. Both
 * `../../../../tmp/evil` and `/tmp/evil` resolved straight through, and packs
 * found there were loaded and their rules executed. Every configured entry now
 * goes through `resolveConfiguredPath`, which keeps it inside the working tree
 * or hands back the documented default. The plugin's own directory is not
 * configured and is not subject to the check: it is where Keel itself lives.
 */
function resolveSearchRoots(
  repoRoot: string,
  pluginRoot: string,
  config: KeelConfig,
): ResolvedRoots {
  const roots = [join(pluginRoot, "standards")];
  const rejected: string[] = [];

  for (const dir of config.standards.dirs) {
    const resolved = resolveConfiguredPath(repoRoot, dir, {
      key: "standards.dirs",
      fallback: DEFAULT_PACK_DIRS[0] ?? "standards",
    });
    if (!resolved.ok) {
      const message = resolved.error ?? `standards.dirs entry \`${dir}\` is outside the repository`;
      logWarn("standards.dirs entry rejected", { dir, error: message });
      rejected.push(message);
      // `resolved.path` is the documented default, inside the repo. Rejecting
      // the value must not also switch off packs the repo legitimately ships.
    }
    roots.push(resolved.path);
  }

  // De-duplicate while preserving order: a repo whose standards dir *is* the
  // plugin dir (this repo, during development) must not load everything twice.
  return { roots: [...new Set(roots)], rejected };
}

/** Directories packs are read from, in ascending precedence. */
export function searchRoots(repoRoot: string, pluginRoot: string, config: KeelConfig): string[] {
  return resolveSearchRoots(repoRoot, pluginRoot, config).roots;
}

/**
 * Glob validation compiles every glob through picomatch, which is far too
 * expensive for the hot path — three hooks call `loadPacks` on every tool call.
 * It runs for `keel check` and `keel doctor`, where a human is waiting and
 * wants to know a pack can never fire.
 */
export interface LoadOptions {
  readonly validate?: boolean;
}

function readPackDir(
  dir: string,
  origin: string,
  options: LoadOptions,
): { pack?: LoadedPack; issues: PackIssue[] } {
  const yamlPath = join(dir, "standard.yaml");
  if (!isFile(yamlPath)) {
    return {
      issues: [
        {
          pack: dir,
          path: "standard.yaml",
          message: "pack directory has no standard.yaml",
          fix: "add a standard.yaml, or remove the directory",
          severity: "error",
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(yamlPath, "utf8"));
  } catch (cause) {
    return {
      issues: [
        {
          pack: dir,
          path: "standard.yaml",
          message: errorMessage(cause),
          fix: "fix the YAML syntax error",
          severity: "error",
        },
      ],
    };
  }

  const parsed = parseStandard(raw);
  if (parsed.standard === null) {
    return {
      issues: parsed.issues.map((i) => ({ ...i, pack: dir, severity: "error" as const })),
    };
  }

  const standard = parsed.standard;
  const issues: PackIssue[] = [];

  // A glob picomatch cannot compile means a pack that silently never fires.
  if (options.validate === true) {
    for (const glob of standard.applies_to) {
      const problem = validateGlob(glob);
      if (problem !== null) {
        issues.push({
          pack: dir,
          path: `applies_to[${standard.applies_to.indexOf(glob)}]`,
          message: `unresolvable glob "${glob}": ${problem}`,
          fix: "use a picomatch-compatible glob, e.g. `services/**/handlers/*.ts`",
          severity: "error",
        });
      }
    }
  }

  const folderName = dir.split(/[\\/]/).pop() ?? "";
  if (folderName !== standard.name) {
    issues.push({
      pack: dir,
      path: "name",
      message: `name "${standard.name}" does not match folder "${folderName}"`,
      fix: `rename the folder to "${standard.name}" or change name to "${folderName}"`,
      severity: "error",
    });
  }

  const ruleTsPath = firstExisting(dir, ["rule.ts", "rule.mts", "rule.mjs", "rule.js"]);
  const rulePyPath = firstExisting(dir, ["rule.py"]);
  const guidePath = firstExisting(dir, ["guide.md"]);
  const rubricPath = firstExisting(dir, ["rubric.md"]);

  // A pack that declares a mode but ships nothing to run is a no-op nobody notices.
  if (standard.mode === "gate" && ruleTsPath === null && rulePyPath === null) {
    issues.push({
      pack: dir,
      path: "mode",
      message: "mode is `gate` but the pack has no rule.ts or rule.py",
      fix: "add a rule file, or change mode to `guide` or `review`",
      severity: "error",
    });
  }
  if (standard.mode === "guide" && guidePath === null) {
    issues.push({
      pack: dir,
      path: "mode",
      message: "mode is `guide` but the pack has no guide.md",
      fix: "add guide.md, or change mode",
      severity: "error",
    });
  }
  if (standard.mode === "review" && rubricPath === null) {
    issues.push({
      pack: dir,
      path: "mode",
      message: "mode is `review` but the pack has no rubric.md",
      fix: "add rubric.md, or change mode",
      severity: "error",
    });
  }

  if (issues.some((i) => i.severity === "error")) return { issues };

  return {
    pack: { standard, dir, origin, ruleTsPath, rulePyPath, guidePath, rubricPath },
    issues,
  };
}

function firstExisting(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const path = join(dir, name);
    if (isFile(path)) return path;
  }
  return null;
}

/** Discover and validate every pack visible to this repo. */
export function loadPacks(
  repoRoot: string,
  pluginRoot: string,
  config: KeelConfig,
  options: LoadOptions = {},
): PackLoadResult {
  const byName = new Map<string, LoadedPack>();
  const issues: PackIssue[] = [];
  const overrides: PackOverride[] = [];
  const disabledSet = new Set(config.standards.disabled);
  const disabled: string[] = [];

  const { roots, rejected } = resolveSearchRoots(repoRoot, pluginRoot, config);
  for (const message of rejected) {
    issues.push({
      pack: repoRoot,
      path: "standards.dirs",
      message,
      fix: "point standards.dirs at a directory inside the repository, e.g. `standards`",
      severity: "error",
    });
  }

  for (const root of roots) {
    if (!isDirectory(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
      const dir = join(root, entry);
      if (!isDirectory(dir)) continue;

      const { pack, issues: packIssues } = readPackDir(dir, root, options);
      issues.push(...packIssues);
      if (pack === undefined) continue;

      if (disabledSet.has(pack.standard.name)) {
        disabled.push(pack.standard.name);
        continue;
      }

      const existing = byName.get(pack.standard.name);
      if (existing !== undefined) {
        overrides.push({ name: pack.standard.name, winner: pack.dir, loser: existing.dir });
        logDebug("pack override", { name: pack.standard.name, winner: pack.dir });
      }
      byName.set(pack.standard.name, pack);
    }
  }

  return {
    packs: [...byName.values()].sort((a, b) => a.standard.name.localeCompare(b.standard.name)),
    issues,
    overrides,
    disabled,
  };
}
