import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * True when `filePath` is strictly inside `root` (rejects `../` escapes and
 * absolute strays).
 *
 * Lexical only: it does not touch the filesystem, so a symlink inside the repo
 * that points out of it still passes. For a configured path — where the value
 * is attacker-influenceable and the repo may ship symlinks — use
 * `resolveConfiguredPath`, which layers symlink resolution on top of this and
 * hands back a safe fallback.
 *
 * `root` itself is *not* inside `root`: the callers of this predicate are asking
 * about a file within the tree, and "the tree" is never the answer.
 */
export function isInsideRepo(root: string, filePath: string): boolean {
  const rel = toRepoRelative(root, filePath);
  // `..` alone is an escape too — it does not start with `../`, which is how
  // the repo's own parent slipped through a prefix-only check.
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * True when `candidate` is at or inside `root`, comparing lexically.
 *
 * Unlike `isInsideRepo`, `root` itself counts as contained: a configured path of
 * `.` is degenerate, but it is not an escape and rejecting it would be a lie.
 */
function containsPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate)).split(sep).join("/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * Resolve symlinks on the longest existing prefix of `p`, keeping the rest.
 *
 * A configured directory usually does not exist yet — the telemetry spool is
 * created on first write — so `realpathSync` on the whole path would throw and
 * tell us nothing. Resolving the part that *does* exist is what catches a
 * committed `\.keel -> /somewhere/outside` symlink.
 */
function realPathOfExistingPrefix(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let current = abs;

  // Depth is a hard stop: a pathological path must not spin here.
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return abs;
}

/**
 * True when `candidate` lands outside `root`.
 *
 * Catches all three forms: a `../` walk, an absolute stray, and an escape
 * through a symlink on whatever part of the path already exists. `candidate`
 * need not exist, and may be relative — it is resolved against `root`.
 *
 * `root` is resolved through symlinks too. Without that, a repo checked out
 * under a symlinked directory (macOS hands out `/tmp/x` for `/private/tmp/x`)
 * would report every one of its own files as an escape.
 *
 * Never throws. When containment cannot be established it returns true, because
 * an unestablished guarantee is not a guarantee.
 */
export function escapesRepo(root: string, candidate: string): boolean {
  try {
    const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    if (!containsPath(root, abs)) return true;
    return !containsPath(realPathOfExistingPrefix(root), realPathOfExistingPrefix(abs));
  } catch {
    return true;
  }
}

export interface ConfiguredPath {
  /** Absolute path to use. Guaranteed inside the repo. */
  readonly path: string;
  /** False when the configured value escaped and `path` is the fallback. */
  readonly ok: boolean;
  /** Actionable message naming the offending config key. Null when `ok`. */
  readonly error: string | null;
}

export interface ConfiguredPathOptions {
  /** Dotted config key, e.g. `telemetry.path` — named in the error. */
  readonly key: string;
  /** Repo-relative default, used when the configured value is rejected. */
  readonly fallback: string;
}

/**
 * Resolve a path that came from `keel.config.yaml` against the repo root,
 * refusing anything that leaves the repo.
 *
 * Every configured path Keel reads or writes — `standards.dirs`,
 * `telemetry.path`, `spec.dir` — goes through here. Config is committed, so a
 * hostile or careless value is a repo-supplied one: `../../../../tmp/evil` and
 * `/tmp/evil` both used to resolve straight through, executing packs and
 * writing spool files outside the working tree.
 *
 * Rejection is never silent and never fatal. Callers get the documented default
 * back, so the feature keeps working, plus an error naming the offending key to
 * log or print. Hooks must fail open: reject the path, log, carry on.
 *
 * ```ts
 * const dir = resolveConfiguredPath(root, config.telemetry.path, {
 *   key: "telemetry.path",
 *   fallback: DEFAULT_TELEMETRY_PATH,
 * });
 * if (!dir.ok) logWarn(dir.error ?? "");
 * use(dir.path);
 * ```
 */
export function resolveConfiguredPath(
  root: string,
  configured: string,
  options: ConfiguredPathOptions,
): ConfiguredPath {
  const { key, fallback } = options;

  if (!escapesRepo(root, configured)) {
    return { path: resolve(root, configured), ok: true, error: null };
  }

  // The fallback is a Keel constant, so it normally resolves cleanly. But it is
  // a *relative* constant, and a repository can make it escape: committing
  // `standards` as a symlink to somewhere outside makes the default value fail
  // the same check the configured value just failed.
  //
  // Falling back to the repo root there was far worse than doing nothing. For
  // `standards.dirs` it made the entire repository a pack search root — `keel
  // check` started offering `.git`, `.keel` and `src` as candidate pack dirs —
  // and, because the walk then descended through the very symlink that caused
  // the problem, an out-of-tree `guide.md` reached the model anyway. The escape
  // was closed at the front door and left open at the back.
  //
  // So when both escape there is no usable path, and we say so with one that
  // exists nowhere: inside `.keel/`, guaranteed empty, so a caller that ignores
  // `ok: false` still reads nothing and writes nothing of consequence.
  if (escapesRepo(root, fallback)) {
    return {
      path: join(keelDir(root), "unusable", key.replace(/[^a-z0-9]+/gi, "-")),
      ok: false,
      error:
        `${key}: "${configured}" resolves outside the repository, and the default ` +
        `"${fallback}" does too — usually because "${fallback}" is a symlink pointing ` +
        `out of the repo. Nothing was read from either. ` +
        `Fix: remove the symlink, then set ${key} to a real repo-relative directory.`,
    };
  }

  return {
    path: resolve(root, fallback),
    ok: false,
    error:
      `${key}: "${configured}" resolves outside the repository and has been ignored — ` +
      `Keel only reads and writes inside the repo. Using "${fallback}" instead. ` +
      `Fix: set ${key} to a repo-relative path such as "${fallback}".`,
  };
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
