import { exec } from "../shared/exec.js";
import { isKeelInternalPath } from "../shared/paths.js";

/**
 * The actual diff text, for `keel review --prompt`.
 *
 * The command Keel itself suggests is
 * `keel review --prompt | claude -p 'Review this change against the rubric'`.
 * That prompt used to carry a heading and a *file list* — a reviewer handed
 * filenames and nothing to review. This assembles the patch instead.
 *
 * Bounded, and honest about the bound. A prompt is a context window: an
 * unbounded diff either fails the call or silently displaces the rubric that
 * gives the review its point. Truncation is stated in the output so the reader
 * knows they are seeing part of it.
 */

/** Roughly 24k tokens of patch — large enough for real changes, small enough to leave room for the rubric. */
export const DEFAULT_DIFF_BUDGET_BYTES = 96_000;

export interface AssembledDiff {
  readonly text: string;
  readonly truncated: boolean;
  /** Files whose patch was dropped entirely because the budget ran out. */
  readonly omittedFiles: readonly string[];
}

function run(root: string, args: readonly string[]): string {
  // A large diff needs a large buffer; the default 32 MB in exec covers it.
  const res = exec("git", args, { cwd: root, timeoutMs: 30_000 });
  if (!res.ok) return "";
  // `git diff --no-index` exits 1 when the files differ, which is the normal case.
  if (res.value.code > 1) return "";
  return res.value.stdout;
}

/** Split a unified diff into per-file chunks, keyed by the `diff --git` header. */
function splitByFile(patch: string): string[] {
  if (patch.trim() === "") return [];
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.filter((c) => c.trim() !== "");
}

function fileNameOf(chunk: string): string {
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
  return header?.[2] ?? header?.[1] ?? "(unknown file)";
}

/**
 * The change as a patch.
 *
 * `against === null` compares the working tree to HEAD, which is what a
 * mid-branch review wants, and includes untracked files — `git diff` omits
 * those, and a brand-new file is exactly the thing a reviewer most needs to
 * see. A ref compares `ref...HEAD`.
 */
export function assembleDiff(
  root: string,
  against: string | null,
  untrackedPaths: readonly string[] = [],
  budgetBytes: number = DEFAULT_DIFF_BUDGET_BYTES,
): AssembledDiff {
  const chunks: string[] = [];

  chunks.push(
    ...splitByFile(
      against === null
        ? run(root, ["diff", "--no-color", "--find-renames", "HEAD"])
        : run(root, ["diff", "--no-color", "--find-renames", `${against}...HEAD`]),
    ),
  );

  if (against === null) {
    for (const path of untrackedPaths) {
      if (isKeelInternalPath(path)) continue;
      const patch = run(root, [
        "diff",
        "--no-color",
        "--no-index",
        "--",
        "/dev/null",
        path,
      ]);
      chunks.push(...splitByFile(patch));
    }
  }

  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const chunk of chunks) {
    if (used + chunk.length > budgetBytes && kept.length > 0) {
      omitted.push(fileNameOf(chunk));
      continue;
    }
    // A single file larger than the whole budget is clipped rather than dropped:
    // seeing the first half of one big file beats seeing none of it.
    if (chunk.length > budgetBytes) {
      kept.push(`${chunk.slice(0, budgetBytes)}\n… patch for ${fileNameOf(chunk)} truncated here`);
      used += budgetBytes;
      continue;
    }
    kept.push(chunk);
    used += chunk.length;
  }

  return {
    text: kept.join("\n"),
    truncated: omitted.length > 0 || used >= budgetBytes,
    omittedFiles: omitted,
  };
}
