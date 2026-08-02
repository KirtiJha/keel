import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/** The CLI, run as a real process — exit codes are the contract CI depends on. */

const CLI = join(PLUGIN_ROOT, "scripts", "cli.mjs");

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function keel(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

let repo: TempRepo;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("missing scripts/cli.mjs — run `npm run build` first");
});

beforeEach(() => {
  repo = TempRepo.create("keel-cli-");
});

afterEach(() => {
  repo.dispose();
});

describe("version and help", () => {
  it("prints a version", () => {
    const run = keel(["version"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints usage for help", () => {
    const run = keel(["help"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("keel <command>");
  });

  it("exits non-zero on an unknown command", () => {
    expect(keel(["frobnicate"], repo.root).status).toBe(1);
  });

  it("exits non-zero on an unknown track", () => {
    const run = keel(["route", "--track", "turbo"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toContain("turbo");
  });
});

describe("init", () => {
  it("creates config, schema, gitignore entry and CLAUDE.md", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));

    const run = keel(["init"], repo.root);
    expect(run.status).toBe(0);

    expect(existsSync(join(repo.root, "keel.config.yaml"))).toBe(true);
    expect(existsSync(join(repo.root, ".keel", "keel.config.schema.json"))).toBe(true);
    expect(existsSync(join(repo.root, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(repo.root, ".gitignore"), "utf8")).toContain(".keel/");
  });

  it("produces a config that passes check", () => {
    repo.write("package.json", JSON.stringify({ name: "demo" }));
    keel(["init"], repo.root);
    expect(keel(["check"], repo.root).stdout).toContain("keel.config.yaml valid");
  });

  it("is idempotent — a second run changes nothing", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "v" } }));
    keel(["init"], repo.root);

    const configBefore = readFileSync(join(repo.root, "keel.config.yaml"), "utf8");
    const claudeBefore = readFileSync(join(repo.root, "CLAUDE.md"), "utf8");

    const second = keel(["init"], repo.root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already");

    expect(readFileSync(join(repo.root, "keel.config.yaml"), "utf8")).toBe(configBefore);
    expect(readFileSync(join(repo.root, "CLAUDE.md"), "utf8")).toBe(claudeBefore);
  });

  it("never clobbers hand-edited CLAUDE.md content", () => {
    repo.write("package.json", JSON.stringify({ name: "demo" }));
    keel(["init"], repo.root);

    const path = join(repo.root, "CLAUDE.md");
    repo.write("CLAUDE.md", `${readFileSync(path, "utf8")}\n## Team notes\n\nKeep this.\n`);

    keel(["init"], repo.root);
    expect(readFileSync(path, "utf8")).toContain("Keep this.");
  });

  it("keeps an existing config unless --force is given", () => {
    repo.write("keel.config.yaml", "version: 1\nrepo:\n  name: hand-written\n  languages: [python]\n");
    keel(["init"], repo.root);
    expect(readFileSync(join(repo.root, "keel.config.yaml"), "utf8")).toContain("hand-written");

    keel(["init", "--force"], repo.root);
    expect(readFileSync(join(repo.root, "keel.config.yaml"), "utf8")).not.toContain("hand-written");
  });

  it("writes SUPERPOWERS_DISABLE_TELEMETRY into .claude/settings.json", () => {
    keel(["init"], repo.root);
    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { env?: Record<string, string> };
    expect(settings.env?.["SUPERPOWERS_DISABLE_TELEMETRY"]).toBe("1");
  });

  it("merges into an existing settings.json without losing keys", () => {
    repo.write(
      ".claude/settings.json",
      JSON.stringify({ outputStyle: "keel", env: { EXISTING: "keep-me" } }, null, 2),
    );
    keel(["init"], repo.root);

    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { outputStyle?: string; env?: Record<string, string> };

    expect(settings.outputStyle).toBe("keel");
    expect(settings.env?.["EXISTING"]).toBe("keep-me");
    expect(settings.env?.["SUPERPOWERS_DISABLE_TELEMETRY"]).toBe("1");
  });

  it("does not reverse a deliberate override", () => {
    repo.write(
      ".claude/settings.json",
      JSON.stringify({ env: { SUPERPOWERS_DISABLE_TELEMETRY: "0" } }, null, 2),
    );
    keel(["init"], repo.root);

    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { env?: Record<string, string> };
    expect(settings.env?.["SUPERPOWERS_DISABLE_TELEMETRY"]).toBe("0");
  });

  it("proposes gotchas without writing any", () => {
    repo.writeCommitted("src/thing.ts", "// careful: this ordering is load-bearing for the parser\nexport const a = 1;\n");
    const run = keel(["init"], repo.root);

    expect(run.stdout).toContain("Gotcha candidates");
    expect(run.stdout).toContain("None has been written");
    expect(readFileSync(join(repo.root, "CLAUDE.md"), "utf8")).not.toContain("## Gotchas");
  });
});

describe("check", () => {
  it("fails when there is no config", () => {
    const run = keel(["check"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("keel init");
  });

  it("names the field and the fix for an invalid config", () => {
    repo.write("keel.config.yaml", "version: 1\nrepo:\n  languages: [typescript]\n");
    const run = keel(["check"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("repo.name");
    expect(run.stdout).toContain("fix:");
  });

  it("reports the reference packs", () => {
    keel(["init"], repo.root);
    const run = keel(["check"], repo.root);
    expect(run.stdout).toContain("no-raw-color-values");
    expect(run.stdout).toContain("error-envelope");
  });

  it("fails on an UNPINNED upstream dependency and says what to do", () => {
    keel(["init"], repo.root);
    repo.write(
      "upstream.lock",
      [
        "version: 1",
        "dependencies:",
        "  superpowers:",
        "    version: UNPINNED",
        '    source: "obra/superpowers"',
        "    owns: [planning]",
      ].join("\n"),
    );

    const run = keel(["check"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("UNPINNED");
    expect(run.stdout).toContain("ask the owning team");
  });

  it("rejects a floating upstream version", () => {
    keel(["init"], repo.root);
    repo.write(
      "upstream.lock",
      ["version: 1", "dependencies:", "  openspec:", "    version: latest", '    source: "x"'].join("\n"),
    );
    const run = keel(["check"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("moving target");
  });

  it("detects a phase-ownership conflict and names both claimants", () => {
    keel(["init"], repo.root);
    repo.write(
      ".claude/skills/rival-planner/SKILL.md",
      ["---", "name: rival-planner", "keel-phases: [classification]", "---", "", "Body."].join("\n"),
    );

    const run = keel(["check"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("classification");
    expect(run.stdout).toContain("rival-planner");
    // keel-init declares classification, so both claimants must be named.
    expect(run.stdout).toContain("keel-init");
  });

  it("reports a broken pack with a fix", () => {
    keel(["init"], repo.root);
    repo.write("standards/oops/standard.yaml", "name: oops\nmode: gate\n");
    const run = keel(["check"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("oops");
  });
});

describe("route", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("routes a small single-file change to quick", () => {
    repo.write("README.md", "# demo\n\nA line.\n");
    const run = keel(["route"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("quick");
  });

  it("routes a migration to full and says why", () => {
    repo.write("db/migrations/0001_init.sql", "CREATE TABLE t (id TEXT);");
    const run = keel(["route"], repo.root);
    expect(run.stdout).toContain("full");
    expect(run.stdout).toContain("force-full path");
    expect(run.stdout).toContain("OpenSpec proposal");
  });

  it("emits machine-readable JSON with --json", () => {
    repo.write("README.md", "# demo\n\nchanged\n");
    const run = keel(["route", "--json"], repo.root);
    const parsed = JSON.parse(run.stdout) as { track: string; effort: string; reasons: string[] };
    expect(parsed.track).toBe("quick");
    expect(parsed.effort).toBe("low");
    expect(Array.isArray(parsed.reasons)).toBe(true);
  });

  it("honours a developer override and records it", () => {
    repo.write("db/migrations/0002.sql", "ALTER TABLE t ADD COLUMN x TEXT;");
    const run = keel(["route", "--track", "quick", "--json"], repo.root);
    const parsed = JSON.parse(run.stdout) as { track: string; reasons: string[] };
    expect(parsed.track).toBe("quick");
    expect(parsed.reasons[0]).toContain("lowered");
  });
});

describe("doctor", () => {
  it("reports version, packs and phase ownership", () => {
    keel(["init"], repo.root);
    const run = keel(["doctor"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Standards packs");
    expect(run.stdout).toContain("no-raw-color-values");
    expect(run.stdout).toContain("Phase ownership");
    expect(run.stdout).toContain("Upstream");
  });

  it("works in a repo with no config at all", () => {
    expect(keel(["doctor"], repo.root).status).toBe(0);
  });

  it("shows the recorded track distribution", () => {
    keel(["init"], repo.root);
    repo.commit("init keel");
    repo.write("README.md", "# a\n\nb\n");
    keel(["route"], repo.root);

    const run = keel(["doctor"], repo.root);
    expect(run.stdout).toContain("Track distribution");
    expect(run.stdout).toContain("quick");
  });
});

describe("telemetry", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("shows an empty spool without failing", () => {
    const run = keel(["telemetry", "show"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing recorded yet");
  });

  // keel: allow-test-change local-only telemetry is now the decision
  // (decisions.md §16), so `ship` no longer reports a missing remote sink.
  it("ships a bundle to local disk and says nothing is transmitted", () => {
    repo.write("README.md", "# a\n\nb\n");
    keel(["route"], repo.root);

    const run = keel(["telemetry", "ship"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("wrote");
    expect(run.stdout).toContain("local only");

    // The bundle is a real file on the same disk, not a staging step.
    const bundle = /wrote \d+ events to (\S+)/.exec(run.stdout)?.[1];
    expect(bundle).toBeTypeOf("string");
    expect(existsSync(bundle as string)).toBe(true);
  });

  it("rejects an unknown subcommand", () => {
    expect(keel(["telemetry", "frobnicate"], repo.root).status).toBe(1);
  });
});

describe("gotchas", () => {
  it("lists candidates without prompting under --list", () => {
    keel(["init"], repo.root);
    repo.writeCommitted(
      "src/thing.ts",
      "// careful: the order of these two calls matters a great deal\nexport const a = 1;\n",
    );

    const run = keel(["gotchas", "--list"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("evidence");
    expect(run.stdout).toContain("Nothing is written unless you confirm it");
  });

  it("reports none found in a clean repo", () => {
    keel(["init"], repo.root);
    expect(keel(["gotchas", "--list"], repo.root).stdout).toContain("none found");
  });
});

describe("check on this repository", () => {
  // keel: allow-test-change renamed from "passes, apart from the documented
  // blocked inputs" — upstream is now pinned, so `keel check` passes outright
  // and the old name asserted the opposite. Keel's own gate 1 flagged the
  // rename as a removed test, which is correct: it cannot tell a rename from a
  // deletion, and this is the escape hatch for when a human can.
  it("passes — upstream is pinned and phase ownership is clean", () => {
    const run = keel(["check"], PLUGIN_ROOT);
    expect(run.stdout).toContain("keel.config.yaml valid");
    expect(run.stdout).toContain("no-raw-color-values");
    expect(run.stdout).toContain("superpowers @");
    expect(run.stdout).toContain("openspec @");
    // Outstanding internal mirrors are warnings by design, never errors.
    expect(run.stdout).toContain("no errors");
    expect(run.status).toBe(0);
  });

  it("keeps spec-kit out of the installed set, so it cannot contend for a phase", () => {
    const run = keel(["check"], PLUGIN_ROOT);
    expect(run.stdout).toContain("spec-kit @ 0.15.1 (pattern source, not installed)");
  });
});
