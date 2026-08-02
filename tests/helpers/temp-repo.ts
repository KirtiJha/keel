import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type KeelConfig, defaultConfig } from "../../src/shared/config.js";

export const PLUGIN_ROOT = resolve(__dirname, "..", "..");

/** A throwaway git repository, committed so `git diff` has a baseline. */
export class TempRepo {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static create(prefix = "keel-test-"): TempRepo {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const repo = new TempRepo(root);
    repo.git(["init", "--quiet"]);
    repo.git(["config", "user.email", "keel@example.test"]);
    repo.git(["config", "user.name", "Keel Tests"]);
    repo.git(["config", "commit.gpgsign", "false"]);
    repo.write(".gitignore", ".keel/\n");
    repo.commit("init");
    return repo;
  }

  git(args: readonly string[]): string {
    return execFileSync("git", [...args], { cwd: this.root, encoding: "utf8", stdio: "pipe" });
  }

  write(relPath: string, content: string): string {
    const abs = join(this.root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  commit(message: string): void {
    this.git(["add", "-A"]);
    this.git(["commit", "--quiet", "--allow-empty", "-m", message]);
  }

  /** Write a file and commit it, so later edits show up as a real diff. */
  writeCommitted(relPath: string, content: string): string {
    const abs = this.write(relPath, content);
    this.commit(`add ${relPath}`);
    return abs;
  }

  config(overrides: Partial<KeelConfig> = {}): KeelConfig {
    return { ...defaultConfig("temp-repo", ["typescript", "python"]), ...overrides };
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
