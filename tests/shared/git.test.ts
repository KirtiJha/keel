import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changedLines, diffSummary, numstatNewPath, readWorkingFile } from "../../src/shared/git.js";

/**
 * Regressions in the git layer, each one a bug that reached a user-visible
 * wrong answer rather than a crash.
 *
 * These are deliberately driven through real git repositories. Every defect
 * below survived a suite that tested the parsing helpers in isolation, because
 * the wrong data was being handed to correct parsers.
 */

let repo: string;

function git(args: readonly string[], cwd = repo): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

function write(relPath: string, content: string): void {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "keel-git-"));
  git(["init", "--quiet"]);
  git(["config", "user.email", "keel@example.test"]);
  git(["config", "user.name", "Keel Test"]);
  git(["config", "commit.gpgsign", "false"]);
  write("README.md", "# fixture\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("numstatNewPath", () => {
  // `--numstat` compresses a rename into one field. Taken literally it produced
  // a path that does not exist, so the file matched no glob and could not be read.
  it("expands a renamed path to the new path", () => {
    expect(numstatNewPath("src/{alpha.ts => beta.ts}")).toBe("src/beta.ts");
  });

  it("expands a move into a new directory", () => {
    expect(numstatNewPath("db/{ => migrations}/0001_init.sql")).toBe("db/migrations/0001_init.sql");
  });

  it("expands the uncompressed arrow form", () => {
    expect(numstatNewPath("old/a.ts => new/b.ts")).toBe("new/b.ts");
  });

  it("leaves an ordinary path alone, including one containing a brace", () => {
    expect(numstatNewPath("src/plain.ts")).toBe("src/plain.ts");
    expect(numstatNewPath("src/{weird}.ts")).toBe("src/{weird}.ts");
  });
});

describe("diffSummary", () => {
  it("reports a renamed file at its new path", () => {
    write("db/0001_init.sql", "create table t(id int);\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "add migration"]);
    mkdirSync(join(repo, "db", "migrations"), { recursive: true });
    git(["mv", "db/0001_init.sql", "db/migrations/0001_init.sql"]);

    const paths = diffSummary(repo, null).files.map((f) => f.path);
    expect(paths).toContain("db/migrations/0001_init.sql");
    expect(paths.some((p) => p.includes("=>"))).toBe(false);
  });

  it("counts a new untracked file's lines the same way git counts a tracked one", () => {
    // `split("\n").length` counted a phantom trailing line, so an untracked
    // 50-line file measured 51 and escalated off the quick track while the same
    // content in a tracked file measured 50.
    const fifty = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    write("notes.md", `${fifty}\n`);

    const untracked = diffSummary(repo, null);
    expect(untracked.addedLines).toBe(50);

    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "notes"]);
    write("notes.md", `${fifty}\nline 50\n`);
    expect(diffSummary(repo, null).addedLines).toBe(1);
  });

  it("counts a new binary file as zero lines, matching numstat's `-`", () => {
    const bytes = Buffer.alloc(4096);
    bytes.write("\0binary\0payload", 0, "utf8");
    writeFileSync(join(repo, "blob.bin"), bytes);

    expect(diffSummary(repo, null).addedLines).toBe(0);
  });
});

describe("changedLines", () => {
  it("reports the lines a commit added when given a base ref", () => {
    // The file list came from `--against` while the line set was hard-wired to
    // HEAD, so on a clean checkout every file yielded an empty set and the
    // mutation gate generated no mutants at all.
    write("src/a.ts", "export const a = 1;\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();

    write("src/a.ts", "export const a = 1;\nexport const b = 2;\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "add b"]);

    const againstBase = changedLines(repo, "src/a.ts", base);
    expect(againstBase.known).toBe(true);
    expect(againstBase.known && [...againstBase.lines]).toEqual([2]);

    // The same query against HEAD sees a clean tree — the old behaviour.
    const againstHead = changedLines(repo, "src/a.ts");
    expect(againstHead.known && againstHead.lines.size).toBe(0);
  });

  it("treats an ignored file as outside the change, not as wholly new", () => {
    // Reading "not tracked" as "every line is new" made the gates evaluate the
    // whole file, so every edit to generated code blocked.
    write(".gitignore", "src/generated.ts\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "-m", "ignore generated"]);
    write("src/generated.ts", "export const g = 1;\nexport const h = 2;\n");

    const result = changedLines(repo, "src/generated.ts");
    expect(result.known).toBe(true);
    expect(result.known && result.lines.size).toBe(0);
  });

  it("still treats a genuinely untracked file as wholly new", () => {
    write("src/fresh.ts", "export const a = 1;\nexport const b = 2;\n");
    const result = changedLines(repo, "src/fresh.ts");
    expect(result.known && [...result.lines]).toEqual([1, 2]);
  });

  it("reports `known: false` outside a git repository rather than guessing", () => {
    // This is the fail-open contract: callers must be able to tell "no lines
    // changed" from "git could not tell us", because answering the second with
    // the first made a hook block an edit to a committed, unmodified file.
    const bare = mkdtempSync(join(tmpdir(), "keel-nogit-"));
    try {
      writeFileSync(join(bare, "a.ts"), "export const a = 1;\n", "utf8");
      const result = changedLines(bare, "a.ts");
      expect(result.known).toBe(false);
      expect(!result.known && result.reason).toMatch(/repository|index/i);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("readWorkingFile", () => {
  it("does not read a symlink as a copy of its target", () => {
    // statSync follows links, so a new symlink presented every symbol in its
    // target as a phantom added export and escalated the track.
    write("src/real.ts", "export function real(): number {\n  return 1;\n}\n");
    symlinkSync(join(repo, "src", "real.ts"), join(repo, "src", "link.ts"));

    expect(readWorkingFile(repo, "src/real.ts")).toContain("export function real");
    expect(readWorkingFile(repo, "src/link.ts")).toBeNull();
  });
});
