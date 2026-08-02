import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONFIG_BASENAME = "keel.config.yaml";
export const KEEL_DIR = ".keel";

/** Walk up from `start` looking for a repo marker. Returns null outside a repo. */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  // Guard against symlink loops and root-reached; depth is a hard stop.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (existsSync(join(dir, CONFIG_BASENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Repo root, or cwd when not in a repo. Hooks must never fail for lack of one. */
export function repoRootOrCwd(start: string = process.cwd()): string {
  return findRepoRoot(start) ?? resolve(start);
}

export function configPath(root: string): string {
  return join(root, CONFIG_BASENAME);
}

export function keelDir(root: string): string {
  return join(root, KEEL_DIR);
}

export function keelSubdir(root: string, ...parts: string[]): string {
  return join(root, KEEL_DIR, ...parts);
}

/**
 * Repo-relative POSIX path. Globs in config are authored with `/`, so every
 * path that will be matched against a glob has to be normalised to `/` first —
 * otherwise every rule silently stops matching on Windows.
 */
export function toRepoRelative(root: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const rel = relative(root, abs);
  return rel.split(sep).join("/");
}

/** True when `filePath` is inside `root` (rejects `../` escapes and absolute strays). */
export function isInsideRepo(root: string, filePath: string): boolean {
  const rel = toRepoRelative(root, filePath);
  return rel !== "" && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * Keel's own working files, which are never part of a developer's change.
 *
 * Both the diff walker and the caller counter must skip these. The router
 * writes its symbol cache *while* it collects signals, so anything that reads
 * the repo without this filter sees Keel's own output: the diff gains a phantom
 * changed file, and `git grep --untracked` finds symbol names inside cached
 * JSON and counts them as callers. Neither is hypothetical — both shipped as
 * bugs until the router fixture suite caught them.
 */
export function isKeelInternalPath(repoRelativePath: string): boolean {
  return repoRelativePath === KEEL_DIR || repoRelativePath.startsWith(`${KEEL_DIR}/`);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
