import { lstatSync, readFileSync } from "node:fs";

import { exec } from "./exec.js";
import { isKeelInternalPath, toRepoRelative } from "./paths.js";
import { type Result, err, ok } from "./result.js";

/**
 * Git access for the router, the gate runner and the gotcha scanner.
 *
 * Everything here is diff-shaped on purpose. Rule of the road 2: gates check
 * changed lines, never whole files — so the primitive the rest of the codebase
 * gets handed is "which lines changed", not "here is the file".
 */

export interface FileChange {
  readonly path: string; // repo-relative, POSIX separators
  readonly added: number;
  readonly removed: number;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

export interface DiffSummary {
  readonly files: readonly FileChange[];
  readonly addedLines: number;
  readonly removedLines: number;
}

const isInternal = isKeelInternalPath;

function git(root: string, args: readonly string[]): Result<string, string> {
  const res = exec("git", args, { cwd: root });
  if (!res.ok) return res;
  if (res.value.code !== 0) {
    return err(`git ${args[0] ?? ""} failed (${res.value.code}): ${res.value.stderr.trim()}`);
  }
  return ok(res.value.stdout);
}

export function isGitRepo(root: string): boolean {
  const res = exec("git", ["rev-parse", "--git-dir"], { cwd: root });
  return res.ok && res.value.code === 0;
}

export function currentBranch(root: string): string {
  const res = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return res.ok ? res.value.trim() : "unknown";
}

const STATUS_MAP: Readonly<Record<string, FileChange["status"]>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "modified",
  T: "modified",
};

/**
 * Changed files with line counts.
 *
 * `against` selects the comparison: a ref compares HEAD..ref-style, and the
 * default (null) compares the working tree against HEAD, which is what a hook
 * firing mid-edit needs.
 */
export function diffSummary(root: string, against: string | null = null): DiffSummary {
  const numstatArgs = against === null
    ? ["diff", "--numstat", "--no-color", "HEAD"]
    : ["diff", "--numstat", "--no-color", `${against}...HEAD`];
  const statusArgs = against === null
    ? ["diff", "--name-status", "--no-color", "HEAD"]
    : ["diff", "--name-status", "--no-color", `${against}...HEAD`];

  const statuses = new Map<string, FileChange["status"]>();
  const statusOut = git(root, statusArgs);
  if (statusOut.ok) {
    for (const line of statusOut.value.split("\n")) {
      if (line.trim() === "") continue;
      const parts = line.split("\t");
      const code = parts[0]?.[0] ?? "M";
      // Renames report both old and new path; the new path is last.
      const path = parts[parts.length - 1];
      if (path !== undefined && path !== "" && !isInternal(path)) {
        statuses.set(path, STATUS_MAP[code] ?? "modified");
      }
    }
  }

  const files: FileChange[] = [];
  let addedLines = 0;
  let removedLines = 0;

  const numstat = git(root, numstatArgs);
  if (numstat.ok) {
    for (const line of numstat.value.split("\n")) {
      if (line.trim() === "") continue;
      const [addRaw, remRaw, ...rest] = line.split("\t");
      const raw = rest[rest.length - 1];
      const path = raw === undefined ? undefined : numstatNewPath(raw);
      if (path === undefined || path === "" || isInternal(path)) continue;
      // "-" marks a binary file; count it as zero lines rather than NaN.
      const added = addRaw === "-" ? 0 : Number.parseInt(addRaw ?? "0", 10);
      const removed = remRaw === "-" ? 0 : Number.parseInt(remRaw ?? "0", 10);
      const a = Number.isFinite(added) ? added : 0;
      const r = Number.isFinite(removed) ? removed : 0;
      addedLines += a;
      removedLines += r;
      files.push({ path, added: a, removed: r, status: statuses.get(path) ?? "modified" });
    }
  }

  // Untracked files are part of the change even though git diff omits them.
  if (against === null) {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
    if (untracked.ok) {
      for (const path of untracked.value.split("\n")) {
        if (path.trim() === "" || isInternal(path)) continue;
        const lines = countLines(root, path);
        addedLines += lines;
        files.push({ path, added: lines, removed: 0, status: "untracked" });
      }
    }
  }

  return { files, addedLines, removedLines };
}

/**
 * Expand a `--numstat` path field to the file's *new* path.
 *
 * With renames enabled git compresses the pair into one field —
 * `src/{alpha.ts => beta.ts}` or `db/{ => migrations}/0001.sql` — and taking
 * that literally produces a path that does not exist. A file moved *into* a
 * `force_full_globs` directory then failed to match, and `readWorkingFile`
 * returned null so symbol analysis was skipped entirely.
 */
export function numstatNewPath(field: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (brace !== null) {
    const [, prefix = "", , to = "", suffix = ""] = brace;
    // `db/{ => migrations}/x` leaves an empty segment when `to` is empty.
    return `${prefix}${to}${suffix}`.replace(/\/{2,}/g, "/");
  }
  const arrow = field.split(" => ");
  return (arrow.length === 2 ? arrow[1] : field) ?? field;
}

/**
 * Lines in a file that git does not track.
 *
 * `split("\n").length` counts a phantom trailing line for any file ending in a
 * newline — which is nearly all of them — so a brand-new 50-line file measured
 * 51 and escalated off the quick track while the same content appended to a
 * *tracked* file measured 49. The two paths now agree.
 *
 * Binary files return 0 rather than a byte-derived line count, matching how
 * `--numstat` reports them as `-`.
 */
function countLines(root: string, repoRelPath: string): number {
  try {
    const buf = readFileSync(`${root}/${repoRelPath}`);
    if (buf.length === 0) return 0;
    // A NUL byte in the first 8 KB is git's own binary heuristic.
    if (buf.subarray(0, 8192).includes(0)) return 0;

    const text = buf.toString("utf8");
    const lines = text.split("\n").length;
    return text.endsWith("\n") ? lines - 1 : lines;
  } catch {
    return 0;
  }
}

/**
 * 1-based line numbers **added or modified** in one file.
 *
 * This is the hard boundary the gate runner enforces: a finding on a line not
 * in this set is dropped, no matter what a pack rule reports.
 *
 * **Why this returns a result rather than a bare Set.** It used to answer an
 * unanswerable question with a confident guess. `git ls-files --error-unmatch`
 * failing was read as "untracked, so every line is new" — but it also fails
 * when git is not installed, when the directory is not a repository, and when
 * the index is corrupt. In all three the gates then evaluated the *whole file*
 * and blocked an edit to a committed, unmodified file with "new exported symbol
 * implemented without an observed failing test". A hook must fail open, and
 * degrading into a confident wrong block is the worst way to fail.
 *
 * So the three cases are now distinct:
 *   - `known: false`  — git could not tell us. Callers report nothing.
 *   - ignored file    — not part of any change; an empty set, never whole-file.
 *   - untracked file  — genuinely new, so every line counts.
 */
export type ChangedLines =
  | { readonly known: true; readonly lines: ReadonlySet<number> }
  | { readonly known: false; readonly reason: string };

const NO_LINES: ReadonlySet<number> = new Set<number>();

export function changedLines(root: string, filePath: string, against?: string | null): ChangedLines {
  const rel = toRepoRelative(root, filePath);

  const tracked = exec("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root });
  if (!tracked.ok) {
    return { known: false, reason: "git is unavailable" };
  }
  // 128 is git's fatal code: not a repository, unreadable index, bad object.
  // 1 is the ordinary "this path is not tracked" answer.
  if (tracked.value.code === 128) {
    return { known: false, reason: "not a git repository, or the index is unreadable" };
  }

  if (tracked.value.code !== 0) {
    // Ignored files are not part of the change at all. Treating them as
    // "wholly new" made every edit to generated code block on every gate.
    const ignored = exec("git", ["check-ignore", "-q", "--", rel], { cwd: root });
    if (ignored.ok && ignored.value.code === 0) {
      return { known: true, lines: NO_LINES };
    }
    const total = countLines(root, rel);
    const all = new Set<number>();
    for (let i = 1; i <= total; i++) all.add(i);
    return { known: true, lines: all };
  }

  // `against` matters: the mutation gate passes a base ref, and comparing to
  // HEAD there yields an empty set on every CI checkout because the tree is
  // clean. That silently reduced the gate to a no-op.
  const base = against === undefined || against === null ? "HEAD" : `${against}...HEAD`;
  const diff = git(root, ["diff", "--unified=0", "--no-color", base, "--", rel]);
  if (!diff.ok) return { known: false, reason: `git diff against ${base} failed` };

  const lines = new Set<number>(parseAddedLineNumbers(diff.value));
  return { known: true, lines };
}

/**
 * Parse `@@ -a,b +c,d @@` hunk headers from a unified diff into the set of
 * 1-based line numbers present in the *new* file.
 */
export function parseAddedLineNumbers(unifiedDiff: string): number[] {
  const out: number[] = [];
  const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of unifiedDiff.split("\n")) {
    const m = HUNK.exec(line);
    if (m === null) continue;
    const start = Number.parseInt(m[1] ?? "0", 10);
    const count = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

/** File contents at a ref, or null when the path does not exist there. */
export function showFile(root: string, ref: string, filePath: string): string | null {
  const rel = toRepoRelative(root, filePath);
  const res = exec("git", ["show", `${ref}:${rel}`], { cwd: root });
  if (!res.ok || res.value.code !== 0) return null;
  return res.value.stdout;
}

/**
 * Working-tree contents, or null when the file is absent.
 *
 * Symlinks read as null rather than as their target. `statSync` follows links,
 * so `ln -s a.ts link.ts` made the router see a second copy of every symbol in
 * `a.ts` — a phantom *added* export that escalated the track. A link is not a
 * source file; the thing it points at is analysed on its own account.
 */
export function readWorkingFile(root: string, filePath: string): string | null {
  const abs = filePath.startsWith("/") ? filePath : `${root}/${filePath}`;
  try {
    if (!lstatSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export interface CommitInfo {
  readonly sha: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/** Recent commits with their touched files, for the gotcha scanner. */
export function recentCommits(root: string, limit = 500): CommitInfo[] {
  const res = git(root, [
    "log",
    `--max-count=${limit}`,
    "--no-merges",
    "--name-only",
    "--pretty=format:%x00%H%x1f%s",
  ]);
  if (!res.ok) return [];

  const commits: CommitInfo[] = [];
  for (const block of res.value.split("\0")) {
    if (block.trim() === "") continue;
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const [sha, subject] = header.split("\x1f");
    if (sha === undefined || sha === "") continue;
    const files = lines.slice(1).filter((l) => l.trim() !== "");
    commits.push({ sha, subject: subject ?? "", files });
  }
  return commits;
}
