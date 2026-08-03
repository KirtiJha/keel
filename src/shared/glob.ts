import picomatch from "picomatch";


export type Matcher = (repoRelativePath: string) => boolean;

const CACHE = new Map<string, Matcher>();

/**
 * Compile a glob set once and reuse it. Config glob lists are stable for the
 * life of a process, and picomatch compilation is the expensive half.
 *
 * `dot: true` because real repos hide things under `.github/`, `.keel/` etc.
 * and a rule that silently skips dotfiles is a rule that is wrong once.
 */
export function compileGlobs(globs: readonly string[]): Matcher {
  if (globs.length === 0) return () => false;
  const key = globs.join("\u0000");
  const cached = CACHE.get(key);
  if (cached) return cached;

  const isMatch = picomatch([...globs], { dot: true });
  const matcher: Matcher = (p) => isMatch(p);
  CACHE.set(key, matcher);
  return matcher;
}

/** Does `repoRelativePath` match any glob in the set? */
export function matchesAny(repoRelativePath: string, globs: readonly string[]): boolean {
  return compileGlobs(globs)(repoRelativePath);
}

/** Which globs in the set matched? Used to explain routing decisions. */
export function matchingGlobs(repoRelativePath: string, globs: readonly string[]): string[] {
  return globs.filter((g) => compileGlobs([g])(repoRelativePath));
}

/**
 * Reject globs picomatch cannot compile, so `keel check` can report them
 * instead of a pack silently never firing.
 */
export function validateGlob(glob: string): string | null {
  if (glob.trim() === "") return "glob is empty";
  try {
    picomatch(glob);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
