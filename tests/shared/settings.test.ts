import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeObjectKey, readSettings, updateSettings } from "../../src/shared/settings.js";

import { TempRepo } from "../helpers/temp-repo.js";

/**
 * Settings writes must stay inside the repo.
 *
 * Git preserves symlinks (mode 120000), so a repository can commit
 * `.claude/settings.json -> /somewhere/outside`. A plain `writeFileSync`
 * follows it: `keel upstream install` wrote through the link, and pointed at
 * `~/.claude/settings.json` that turns a project-scope write into a
 * user-global one.
 */

let repo: TempRepo;
let outside: string;

beforeEach(() => {
  repo = TempRepo.create("keel-settings-");
  outside = mkdtempSync(join(tmpdir(), "keel-settings-outside-"));
});

afterEach(() => {
  repo.dispose();
  rmSync(outside, { recursive: true, force: true });
});

const ORIGINAL = JSON.stringify({ theirs: true });

describe("symlinked settings", () => {
  it("refuses to write through a symlinked settings.json", () => {
    const target = join(outside, "settings.json");
    writeFileSync(target, ORIGINAL, "utf8");
    mkdirSync(join(repo.root, ".claude"), { recursive: true });
    symlinkSync(target, join(repo.root, ".claude", "settings.json"));

    const result = updateSettings(repo.root, "project", (current) =>
      mergeObjectKey(current, "env", { KEEL_UPSTREAM: "1" }),
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(ORIGINAL);
  });

  it("names the file and the reason so the developer can fix it", () => {
    const target = join(outside, "settings.json");
    writeFileSync(target, ORIGINAL, "utf8");
    mkdirSync(join(repo.root, ".claude"), { recursive: true });
    symlinkSync(target, join(repo.root, ".claude", "settings.json"));

    const result = updateSettings(repo.root, "project", (c) => ({ ...c, a: 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/symlink/i);
    expect(result.error).toContain("settings.json");
  });

  it("leaves the symlink itself in place rather than replacing it", () => {
    const target = join(outside, "settings.json");
    writeFileSync(target, ORIGINAL, "utf8");
    mkdirSync(join(repo.root, ".claude"), { recursive: true });
    const link = join(repo.root, ".claude", "settings.json");
    symlinkSync(target, link);

    updateSettings(repo.root, "project", (c) => ({ ...c, a: 1 }));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses when the whole .claude directory is a symlink out of the repo", () => {
    symlinkSync(outside, join(repo.root, ".claude"), "dir");

    const result = updateSettings(repo.root, "local", (c) => ({ ...c, effortLevel: "high" }));

    expect(result.ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not read settings through a symlink either", () => {
    writeFileSync(join(outside, "settings.json"), JSON.stringify({ stolen: true }), "utf8");
    mkdirSync(join(repo.root, ".claude"), { recursive: true });
    symlinkSync(join(outside, "settings.json"), join(repo.root, ".claude", "settings.json"));

    expect(readSettings(repo.root, "project").settings["stolen"]).toBeUndefined();
  });
});

describe("atomic writes", () => {
  it("leaves no temporary files behind", () => {
    updateSettings(repo.root, "project", (c) => ({ ...c, a: 1 }));
    expect(readdirSync(join(repo.root, ".claude"))).toEqual(["settings.json"]);
  });

  it("keeps the previous content intact when the update declines", () => {
    repo.write(".claude/settings.json", JSON.stringify({ env: { A: "1" } }, null, 2));
    const before = readFileSync(join(repo.root, ".claude/settings.json"), "utf8");
    updateSettings(repo.root, "project", () => null);
    expect(readFileSync(join(repo.root, ".claude/settings.json"), "utf8")).toBe(before);
  });

  it("still merges without clobbering keys it does not own", () => {
    repo.write(".claude/settings.json", JSON.stringify({ outputStyle: "keel", env: { A: "1" } }));
    updateSettings(repo.root, "project", (c) => mergeObjectKey(c, "env", { A: "theirs", B: "2" }));

    const settings = readSettings(repo.root, "project").settings;
    expect(settings["outputStyle"]).toBe("keel");
    expect(settings["env"]).toEqual({ A: "1", B: "2" });
  });

  it("still refuses to overwrite a file it cannot parse", () => {
    repo.write(".claude/settings.json", "{ not json");
    const result = updateSettings(repo.root, "project", (c) => ({ ...c, a: 1 }));
    expect(result.ok && result.value).toBe("unreadable");
    expect(readFileSync(join(repo.root, ".claude/settings.json"), "utf8")).toBe("{ not json");
  });
});
