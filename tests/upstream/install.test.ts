import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classify,
  marketplaceSettings,
  npmPackageName,
  planInstall,
  runInstall,
  upstreamStatus,
} from "../../src/upstream/install.js";
import { loadLock, type UpstreamDependency, type UpstreamLock } from "../../src/upstream/lock.js";
import {
  EFFORT_LEVELS,
  readEffortLevel,
  readSettings,
  readSkillOverrides,
  setEffortLevel,
  setSkillOverrides,
  updateSettings,
  mergeObjectKey,
} from "../../src/shared/settings.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-upstream-");
});

afterEach(() => {
  repo.dispose();
});

function dep(overrides: Partial<UpstreamDependency> = {}): UpstreamDependency {
  return {
    version: "1.0.0",
    source: "x/y",
    role: "install",
    owns: [],
    ...overrides,
  } as UpstreamDependency;
}

function lock(dependencies: Record<string, UpstreamDependency>): UpstreamLock {
  return { version: 1, dependencies } as UpstreamLock;
}

// ---------------------------------------------------------------------------
// Settings module
// ---------------------------------------------------------------------------

describe("settings", () => {
  it("creates a file that does not exist", () => {
    const result = updateSettings(repo.root, "project", (c) => ({ ...c, a: 1 }));
    expect(result.ok && result.value).toBe("created");
    expect(readSettings(repo.root, "project").settings["a"]).toBe(1);
  });

  it("merges without losing existing keys", () => {
    repo.write(".claude/settings.json", JSON.stringify({ outputStyle: "keel", env: { A: "1" } }));
    updateSettings(repo.root, "project", (c) => mergeObjectKey(c, "env", { B: "2" }));

    const settings = readSettings(repo.root, "project").settings;
    expect(settings["outputStyle"]).toBe("keel");
    expect(settings["env"]).toEqual({ A: "1", B: "2" });
  });

  it("never reverses a value someone already set", () => {
    repo.write(".claude/settings.json", JSON.stringify({ env: { A: "mine" } }));
    updateSettings(repo.root, "project", (c) => mergeObjectKey(c, "env", { A: "theirs" }));
    expect(readSettings(repo.root, "project").settings["env"]).toEqual({ A: "mine" });
  });

  it("reports unchanged rather than rewriting identical content", () => {
    repo.write(".claude/settings.json", JSON.stringify({ env: { A: "1" } }, null, 2));
    const result = updateSettings(repo.root, "project", (c) => mergeObjectKey(c, "env", { A: "1" }));
    expect(result.ok && result.value).toBe("unchanged");
  });

  it("refuses to overwrite a settings file it cannot parse", () => {
    repo.write(".claude/settings.json", "{ not json");
    const result = updateSettings(repo.root, "project", (c) => ({ ...c, a: 1 }));
    expect(result.ok && result.value).toBe("unreadable");
    expect(readFileSync(join(repo.root, ".claude/settings.json"), "utf8")).toBe("{ not json");
  });

  it("keeps project and local settings separate", () => {
    updateSettings(repo.root, "project", (c) => ({ ...c, scope: "project" }));
    updateSettings(repo.root, "local", (c) => ({ ...c, scope: "local" }));
    expect(readSettings(repo.root, "project").settings["scope"]).toBe("project");
    expect(readSettings(repo.root, "local").settings["scope"]).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Gap 1 — effort by track
// ---------------------------------------------------------------------------

describe("effort level", () => {
  it("writes effortLevel to settings.local.json, not the shared project file", () => {
    setEffortLevel(repo.root, "high");
    expect(readEffortLevel(repo.root)).toBe("high");
    expect(readSettings(repo.root, "project").settings["effortLevel"]).toBeUndefined();
  });

  it("overwrites on a later call — the track changed, so the level must", () => {
    setEffortLevel(repo.root, "low");
    setEffortLevel(repo.root, "high");
    expect(readEffortLevel(repo.root)).toBe("high");
  });

  it("reports unchanged when the level already matches", () => {
    setEffortLevel(repo.root, "medium");
    const second = setEffortLevel(repo.root, "medium");
    expect(second.ok && second.value).toBe("unchanged");
  });

  it("preserves other local settings", () => {
    repo.write(".claude/settings.local.json", JSON.stringify({ mine: true }));
    setEffortLevel(repo.root, "low");
    expect(readSettings(repo.root, "local").settings["mine"]).toBe(true);
  });

  it("accepts only the levels Claude Code documents", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh"]);
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — skill overrides
// ---------------------------------------------------------------------------

describe("skill overrides", () => {
  it("writes an off state for each named skill", () => {
    setSkillOverrides(repo.root, { "some-skill": "off", other: "name-only" });
    expect(readSkillOverrides(repo.root)).toEqual({ "some-skill": "off", other: "name-only" });
  });

  it("merges with overrides already present", () => {
    repo.write(".claude/settings.local.json", JSON.stringify({ skillOverrides: { kept: "on" } }));
    setSkillOverrides(repo.root, { added: "off" });
    expect(readSkillOverrides(repo.root)).toEqual({ kept: "on", added: "off" });
  });

  it("is a no-op for an empty set", () => {
    const result = setSkillOverrides(repo.root, {});
    expect(result.ok && result.value).toBe("unchanged");
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — upstream install
// ---------------------------------------------------------------------------

describe("install command classification", () => {
  it.each([
    ["npm install --save-exact @scope/pkg@1.2.3", "npm"],
    ["pnpm add pkg@1.0.0", "npm"],
    ["claude plugin marketplace add owner/repo", "plugin"],
    ["claude plugin install thing@market", "plugin"],
    ["make setup", "unknown"],
    ["", "unknown"],
  ])("classifies %s as %s", (install, kind) => {
    expect(classify(dep({ install }))).toBe(kind);
  });

  it("extracts a scoped package name without its version", () => {
    expect(npmPackageName(dep({ install: "npm install --save-exact @fission-ai/openspec@1.7.0" }))).toBe(
      "@fission-ai/openspec",
    );
  });

  it("extracts an unscoped package name", () => {
    expect(npmPackageName(dep({ install: "npm install thing@2.0.0" }))).toBe("thing");
  });

  it("returns null for a non-npm command", () => {
    expect(npmPackageName(dep({ install: "claude plugin marketplace add a/b" }))).toBeNull();
  });
});

describe("upstream status", () => {
  it("reports an npm dependency as missing when node_modules has nothing", () => {
    const status = upstreamStatus(
      repo.root,
      lock({ thing: dep({ install: "npm install thing@1.0.0" }) }),
    );
    expect(status[0]?.state).toBe("missing");
    expect(status[0]?.detail).toContain("keel upstream install");
  });

  it("reports installed when the version matches the pin", () => {
    repo.write("node_modules/thing/package.json", JSON.stringify({ name: "thing", version: "1.0.0" }));
    const status = upstreamStatus(
      repo.root,
      lock({ thing: dep({ version: "1.0.0", install: "npm install thing@1.0.0" }) }),
    );
    expect(status[0]?.state).toBe("installed");
  });

  it("reports a version mismatch with both numbers", () => {
    repo.write("node_modules/thing/package.json", JSON.stringify({ name: "thing", version: "0.9.0" }));
    const status = upstreamStatus(
      repo.root,
      lock({ thing: dep({ version: "1.0.0", install: "npm install thing@1.0.0" }) }),
    );
    expect(status[0]?.state).toBe("wrong-version");
    expect(status[0]?.detail).toContain("0.9.0");
    expect(status[0]?.detail).toContain("1.0.0");
  });

  it("handles a scoped package", () => {
    repo.write(
      "node_modules/@fission-ai/openspec/package.json",
      JSON.stringify({ name: "@fission-ai/openspec", version: "1.7.0" }),
    );
    const status = upstreamStatus(
      repo.root,
      lock({
        openspec: dep({
          version: "1.7.0",
          install: "npm install --save-exact @fission-ai/openspec@1.7.0",
        }),
      }),
    );
    expect(status[0]?.state).toBe("installed");
  });

  it("calls a plugin unverifiable rather than missing — its state lives outside the repo", () => {
    const status = upstreamStatus(
      repo.root,
      lock({ sp: dep({ source: "obra/superpowers", install: "claude plugin marketplace add obra/superpowers" }) }),
    );
    expect(status[0]?.state).toBe("unverifiable");
    expect(status[0]?.detail).toContain("/plugin");
  });

  it("counts a declared marketplace as configured", () => {
    repo.write(
      ".claude/settings.json",
      JSON.stringify({ extraKnownMarketplaces: { sp: { source: { source: "github", repo: "obra/superpowers" } } } }),
    );
    const status = upstreamStatus(
      repo.root,
      lock({ sp: dep({ source: "obra/superpowers", install: "claude plugin marketplace add obra/superpowers" }) }),
    );
    expect(status[0]?.state).toBe("installed");
  });

  it("ignores pattern sources entirely", () => {
    expect(upstreamStatus(repo.root, lock({ sk: dep({ role: "pattern-source" }) }))).toEqual([]);
  });
});

describe("install planning", () => {
  it("skips a dependency already at its pin", () => {
    repo.write("node_modules/thing/package.json", JSON.stringify({ name: "thing", version: "1.0.0" }));
    const plan = planInstall(
      repo.root,
      lock({ thing: dep({ version: "1.0.0", install: "npm install thing@1.0.0" }) }),
    );
    expect(plan[0]?.skipped).toBe(true);
    expect(plan[0]?.reason).toContain("already at the pinned version");
  });

  it("plans a missing dependency", () => {
    const plan = planInstall(repo.root, lock({ thing: dep({ install: "npm install thing@1.0.0" }) }));
    expect(plan[0]?.skipped).toBe(false);
    expect(plan[0]?.command).toBe("npm install thing@1.0.0");
  });

  it("skips an entry with no recorded install command rather than inventing one", () => {
    const plan = planInstall(repo.root, lock({ thing: dep() }));
    expect(plan[0]?.skipped).toBe(true);
    expect(plan[0]?.reason).toContain("no `install:` command");
  });

  it("runs nothing under --dry-run", () => {
    const result = runInstall(
      repo.root,
      lock({ thing: dep({ install: "touch SHOULD_NOT_EXIST" }) }),
      { dryRun: true },
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value[0]?.ran).toBe(false);
  });

  it("runs the recorded command verbatim", () => {
    const result = runInstall(repo.root, lock({ thing: dep({ install: "touch INSTALLED" }) }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value[0]?.ok).toBe(true);
    expect(readSettings(repo.root, "project").existed).toBe(false);
    expect(() => readFileSync(join(repo.root, "INSTALLED"), "utf8")).not.toThrow();
  });

  it("reports a failing install command without throwing", () => {
    const result = runInstall(repo.root, lock({ thing: dep({ install: "exit 3" }) }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value[0]?.ok).toBe(false);
  });
});

describe("marketplace settings", () => {
  it("emits an entry only when the marketplace name is recorded", () => {
    const withName = marketplaceSettings(
      lock({
        sp: dep({
          source: "obra/superpowers",
          install: "claude plugin marketplace add obra/superpowers",
          marketplace_name: "superpowers",
        }),
      }),
    );
    expect(withName).toEqual({
      superpowers: { source: { source: "github", repo: "obra/superpowers" } },
    });
  });

  it("emits nothing when the name is unknown — the key must match the real one", () => {
    const withoutName = marketplaceSettings(
      lock({ sp: dep({ source: "obra/superpowers", install: "claude plugin marketplace add obra/superpowers" }) }),
    );
    expect(withoutName).toEqual({});
  });

  it("uses a git source for a full URL", () => {
    const settings = marketplaceSettings(
      lock({
        sp: dep({
          source: "https://gitlab.com/org/plugins.git",
          install: "claude plugin marketplace add https://gitlab.com/org/plugins.git",
          marketplace_name: "org-plugins",
        }),
      }),
    );
    expect(settings["org-plugins"]).toEqual({
      source: { source: "git", url: "https://gitlab.com/org/plugins.git" },
    });
  });
});

describe("this repository's lock", () => {
  it("records an install command for every installed dependency", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    if (!loaded.ok) throw new Error(loaded.error);

    for (const [name, dependency] of Object.entries(loaded.value.dependencies)) {
      if (dependency.role !== "install") continue;
      expect(dependency.install, `${name} needs an install: command`).toBeDefined();
    }
  });

  it("plans real steps for it", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    if (!loaded.ok) throw new Error(loaded.error);

    const plan = planInstall(repo.root, loaded.value);
    expect(plan.map((s) => s.name).sort()).toEqual(["openspec", "superpowers"]);
    expect(plan.every((s) => s.command !== "")).toBe(true);
  });
});
