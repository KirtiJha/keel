import { readFileSync } from "node:fs";

import { exec } from "./exec.js";
import { isFile, isKeelInternalPath, toRepoRelative } from "./paths.js";
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

export function headSha(root: string): string | null {
  const res = git(root, ["rev-parse", "HEAD"]);
  return res.ok ? res.value.trim() : null;
}

/** Merge base against a base ref; falls back to the ref itself when unrelated. */
export function mergeBase(root: string, baseRef: string): string | null {
  const res = git(root, ["merge-base", "HEAD", baseRef]);
  if (res.ok) return res.value.trim();
  const direct = git(root, ["rev-parse", baseRef]);
  return direct.ok ? direct.value.trim() : null;
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
      const path = rest[rest.length - 1];
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

function countLines(root: string, repoRelPath: string): number {
  try {
    const text = readFileSync(`${root}/${repoRelPath}`, "utf8");
    if (text === "") return 0;
    return text.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * 1-based line numbers **added or modified** in the working copy of one file.
 *
 * This is the hard boundary the gate runner enforces. A finding on a line not
 * in this set is dropped, no matter what a pack rule reports.
 */
export function changedLines(root: string, filePath: string): Set<number> {
  const rel = toRepoRelative(root, filePath);
  const result = new Set<number>();

  // Untracked: every line is new.
  const tracked = exec("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root });
  const isTracked = tracked.ok && tracked.value.code === 0;
  if (!isTracked) {
    const total = countLines(root, rel);
    for (let i = 1; i <= total; i++) result.add(i);
    return result;
  }

  const diff = git(root, ["diff", "--unified=0", "--no-color", "HEAD", "--", rel]);
  if (!diff.ok) return result;
  for (const line of parseAddedLineNumbers(diff.value)) result.add(line);
  return result;
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

/** Working-tree contents, or null when the file is absent. */
export function readWorkingFile(root: string, filePath: string): string | null {
  const abs = filePath.startsWith("/") ? filePath : `${root}/${filePath}`;
  if (!isFile(abs)) return null;
  try {
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
