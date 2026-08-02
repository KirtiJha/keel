import { exec } from "../shared/exec.js";
import { type Result, err, ok } from "../shared/result.js";

/**
 * Validating `--against` before anything routes off it.
 *
 * `diffSummary` runs `git diff <ref>...HEAD` and ignores a non-zero exit, so an
 * unresolvable ref produced "0 files, no files changed" — track quick, exit 0,
 * empty stderr. In CI that means every process gate silently evaporates the
 * first time someone points at a ref the runner never fetched. A ref that does
 * not resolve is now an error before any work is done.
 *
 * The check lives in the CLI layer on purpose: `src/shared/git.ts` is the
 * fail-open primitive the hooks use, and hooks must never abort for want of a
 * ref. A person typing `--against` is asking a question that has no honest
 * answer when the ref is missing.
 */

export interface ResolvedRef {
  readonly ref: string;
  readonly sha: string;
}

const NEEDS_FETCH = /^(?:origin|upstream)\//;

export function resolveRef(root: string, ref: string): Result<ResolvedRef, string> {
  const trimmed = ref.trim();
  if (trimmed === "") {
    return err("`--against` was given an empty ref — pass one, e.g. `--against main`");
  }

  const inside = exec("git", ["rev-parse", "--git-dir"], { cwd: root });
  if (!inside.ok || inside.value.code !== 0) {
    return err(
      `not a git repository, so \`--against ${trimmed}\` cannot be resolved — ` +
        "run this from inside a checkout, or drop `--against`",
    );
  }

  const res = exec("git", ["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`], {
    cwd: root,
  });
  const sha = res.ok && res.value.code === 0 ? res.value.stdout.trim() : "";
  if (sha === "") {
    const fetchHint = NEEDS_FETCH.test(trimmed)
      ? ` — fetch it first: \`git fetch ${trimmed.split("/")[0] ?? "origin"} ${trimmed.split("/").slice(1).join("/")}\``
      : " — check the spelling, or `git fetch` the branch it lives on";
    return err(`cannot resolve \`${trimmed}\`: no such commit in this repository${fetchHint}`);
  }

  return ok({ ref: trimmed, sha });
}
