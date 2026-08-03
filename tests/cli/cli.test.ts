import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../../src/shared/config.js";
import { validateConfig } from "../../src/shared/config-schema.js";
import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/** The CLI, run as a real process — exit codes are the contract CI depends on. */

const CLI = join(PLUGIN_ROOT, "scripts", "cli.mjs");

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `env` overrides the inherited environment for one run.
 *
 * The case that matters is `KEEL_HOME`: trust approvals are signed with a
 * machine key kept outside every repository, so a test that wants the *consumer*
 * experience — a checkout that has never approved anything, on a machine that
 * has no key — has to point that key somewhere fresh. Inheriting the developer's
 * own `~/.keel` is how the untrusted path stops being exercised.
 */
function keel(args: readonly string[], cwd: string, env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
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

// ---------------------------------------------------------------------------
// Correctness fixes
// ---------------------------------------------------------------------------

describe("--version", () => {
  it("prints the version, not the usage screen", () => {
    // `case "--version"` was unreachable: parseArgs put it in flags, so
    // positional[0] was undefined and the command defaulted to help.
    const run = keel(["--version"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run.stdout).not.toContain("keel <command>");
  });

  it.each([["-v"], ["-V"]])("prints the version for %s", (flag) => {
    expect(keel([flag], repo.root).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("agrees with `keel version`", () => {
    expect(keel(["--version"], repo.root).stdout).toBe(keel(["version"], repo.root).stdout);
  });
});

describe("unknown flags", () => {
  it("rejects a mistyped --track rather than ignoring it", () => {
    // `keel route --trak full` exited 0 having ignored the typo, so a developer
    // believed they had overridden the track and had not.
    const run = keel(["route", "--trak", "full"], repo.root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--trak");
    expect(run.stderr).toContain("did you mean `--track`");
  });

  it("rejects unknown flags on check and names both", () => {
    const run = keel(["check", "--wibble", "--explode=yes"], repo.root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--wibble");
    expect(run.stderr).toContain("--explode");
  });

  it("lists the flags the command does accept", () => {
    expect(keel(["route", "--wibble"], repo.root).stderr).toContain("--apply-effort");
  });

  it("suggests a near-miss command instead of dumping the usage screen", () => {
    const run = keel(["rout"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("did you mean `keel route`");
    expect(run.stdout).not.toContain("Usage");
  });

  it("suggests a near-miss subcommand", () => {
    const run = keel(["upstream", "instal"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("keel upstream install");
  });

  it("still prints usage for --help", () => {
    const run = keel(["--help"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("keel <command>");
  });

  it("documents the flags `review record` reads", () => {
    const help = keel(["help"], repo.root).stdout;
    for (const flag of ["--human-comments", "--bot-comments", "--reviews", "--changed-files"]) {
      expect(help, flag).toContain(flag);
    }
  });

  it("documents the gate and trust commands", () => {
    const help = keel(["help"], repo.root).stdout;
    expect(help).toContain("gate");
    expect(help).toContain("trust");
  });
});

describe("--against", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("fails loudly on a ref that does not resolve", () => {
    // It used to yield "0 files, no files changed", track quick, exit 0 and an
    // empty stderr — in CI, every process gate silently evaporating.
    const run = keel(["route", "--against", "origin/main"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("cannot resolve `origin/main`");
    expect(run.stderr).toContain("git fetch");
    expect(run.stdout).not.toContain("quick");
  });

  it("rejects --against with no value", () => {
    const run = keel(["route", "--against"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("needs a value");
  });

  it("accepts a ref that does resolve", () => {
    repo.write("README.md", "# demo\n\nchanged\n");
    const run = keel(["route", "--against", "HEAD"], repo.root);
    expect(run.status).toBe(0);
  });

  it("guards mutate, review and gate the same way", () => {
    for (const command of ["mutate", "review", "gate"]) {
      const run = keel([command, "--against", "nope/nowhere"], repo.root);
      expect(run.status, command).toBe(1);
      expect(run.stderr, command).toContain("cannot resolve");
    }
  });
});

describe("review --prompt", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("includes the diff, not just a file list", () => {
    // The command Keel suggests is `keel review --prompt | claude -p '...'`,
    // which used to hand a reviewer filenames and nothing to review.
    repo.writeCommitted("src/thing.ts", "export const a = 1;\n");
    repo.write("src/thing.ts", "export const a = 2;\n");

    const run = keel(["review", "--prompt"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("# Diff under review");
    expect(run.stdout).toContain("```diff");
    expect(run.stdout).toContain("-export const a = 1;");
    expect(run.stdout).toContain("+export const a = 2;");
  });

  it("includes untracked files, which git diff omits", () => {
    repo.write("src/brand-new.ts", "export const added = true;\n");
    const run = keel(["review", "--prompt"], repo.root);
    expect(run.stdout).toContain("brand-new.ts");
    expect(run.stdout).toContain("+export const added = true;");
  });

  it("says so when the diff is truncated", () => {
    const huge = Array.from({ length: 12_000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    repo.write("src/huge.ts", `${huge}\n`);
    repo.write("src/also-huge.ts", `${huge}\n`);

    const run = keel(["review", "--prompt"], repo.root);
    expect(run.stdout).toContain("truncated");
    expect(run.stdout).toContain("git diff");
  });
});

describe("spec delta counts requirements", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("reports zero for a freshly scaffolded, empty proposal", () => {
    // It used to render "+ 1 added · ~ 1 modified · - 1 removed" for a proposal
    // with three empty headings and no requirements written at all.
    expect(keel(["spec", "new", "add-retries"], repo.root).status).toBe(0);

    const run = keel(["spec", "delta", "--change", "add-retries"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("+ 1 added");
    expect(run.stdout).not.toContain("- 1 removed");
    expect(run.stdout).toContain("No requirements yet");
  });

  it("counts requirements once they are written", () => {
    keel(["spec", "new", "add-retries"], repo.root);
    const proposal = join(repo.root, "openspec", "changes", "add-retries", "proposal.md");
    repo.write(
      "openspec/changes/add-retries/proposal.md",
      readFileSync(proposal, "utf8").replace(
        "## ADDED Requirements\n",
        "## ADDED Requirements\n\n### Requirement: Retry on 5xx\n\nThe system SHALL retry.\n",
      ),
    );

    const run = keel(["spec", "delta", "--change", "add-retries", "--json"], repo.root);
    const parsed = JSON.parse(run.stdout) as { requirements: number; sections: number };
    expect(parsed.requirements).toBe(1);
    expect(parsed.sections).toBe(3);
  });
});

describe("init and upstream.lock", () => {
  it("creates an upstream.lock, so the message telling you to run init is true", () => {
    const run = keel(["init"], repo.root);
    expect(run.status).toBe(0);
    expect(existsSync(join(repo.root, "upstream.lock"))).toBe(true);

    const status = keel(["upstream", "status"], repo.root);
    expect(status.status).toBe(0);
    expect(status.stdout).not.toContain("no upstream.lock");
  });

  it("keeps a hand-written lock", () => {
    repo.write("upstream.lock", "version: 1\ndependencies: {}\n# mine\n");
    keel(["init"], repo.root);
    expect(readFileSync(join(repo.root, "upstream.lock"), "utf8")).toContain("# mine");
  });

  it("leaves check and doctor with no unfixable upstream warning", () => {
    keel(["init"], repo.root);
    expect(keel(["check"], repo.root).stdout).not.toContain("no upstream.lock");
    expect(keel(["doctor"], repo.root).stdout).not.toContain("no upstream.lock");
  });

  it("is still byte-identical across repeated runs", () => {
    repo.write("package.json", JSON.stringify({ name: "demo" }));
    keel(["init"], repo.root);
    const lockBefore = readFileSync(join(repo.root, "upstream.lock"), "utf8");
    keel(["init"], repo.root);
    keel(["init"], repo.root);
    expect(readFileSync(join(repo.root, "upstream.lock"), "utf8")).toBe(lockBefore);
  });

  it("tells you to commit its own files, so they do not route your next change", () => {
    const run = keel(["init"], repo.root);
    expect(run.stdout).toContain("commit these files");
    expect(run.stdout).toContain("git add");
  });
});

describe("init outside a git repository", () => {
  it("warns, and names the fix", () => {
    const bare = mkdtempSync(join(tmpdir(), "keel-nogit-"));
    try {
      const run = keel(["init"], bare);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("not a git repository");
      expect(run.stdout).toContain("git init");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("gives check a fix line for the same condition", () => {
    const bare = mkdtempSync(join(tmpdir(), "keel-nogit-"));
    try {
      keel(["init"], bare);
      const run = keel(["check"], bare);
      expect(run.stdout).toContain("not a git repository");
      expect(run.stdout).toContain("git init");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("upstream install state", () => {
  it("does not report a tick for something that is not installed", () => {
    // doctor ran only validateLock — is the pin well-formed? — and never asked
    // whether the dependency was present, so it printed a tick for a package
    // `keel upstream status` correctly reported as missing.
    keel(["init"], repo.root);
    repo.write(
      "upstream.lock",
      [
        "version: 1",
        "dependencies:",
        "  openspec:",
        '    version: "1.7.0"',
        '    source: "@fission-ai/openspec"',
        "    role: install",
        '    install: "npm install --save-exact @fission-ai/openspec@1.7.0"',
        '    mirror: "internal/openspec@1.7.0"',
        "",
      ].join("\n"),
    );

    const missing = keel(["upstream", "status"], repo.root);
    expect(missing.status).toBe(1);

    const doc = keel(["doctor"], repo.root);
    expect(doc.stdout).toContain("NOT installed");

    const chk = keel(["check"], repo.root);
    expect(chk.stdout).toContain("NOT installed");
    expect(chk.stdout).toContain("keel upstream install");
  });

  it("reports installed when the package really is there", () => {
    keel(["init"], repo.root);
    repo.write(
      "node_modules/@fission-ai/openspec/package.json",
      JSON.stringify({ name: "@fission-ai/openspec", version: "1.7.0" }),
    );
    repo.write(
      "upstream.lock",
      [
        "version: 1",
        "dependencies:",
        "  openspec:",
        '    version: "1.7.0"',
        '    source: "@fission-ai/openspec"',
        "    role: install",
        '    install: "npm install --save-exact @fission-ai/openspec@1.7.0"',
        '    mirror: "internal/openspec@1.7.0"',
        "",
      ].join("\n"),
    );
    expect(keel(["doctor"], repo.root).stdout).toContain("openspec @ 1.7.0 installed");
  });
});

describe("upstream install does not declare marketplaces on its own", () => {
  const lockWithMarketplace = [
    "version: 1",
    "dependencies:",
    "  demo:",
    '    version: "1.0.0"',
    '    source: "owner/demo"',
    "    role: install",
    '    marketplace_name: "demo-market"',
    '    mirror: "internal/demo@1.0.0"',
  ].join("\n");

  it("asks for confirmation before writing to the committed settings.json", () => {
    keel(["init"], repo.root);
    repo.write(
      "upstream.lock",
      `${lockWithMarketplace}\n    install: "echo plugin marketplace add owner/demo#v1.0.0"\n`,
    );

    const run = keel(["upstream", "install"], repo.root);
    expect(run.stdout).toContain("not declared");
    expect(run.stdout).toContain("--yes");

    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { extraKnownMarketplaces?: Record<string, unknown> };
    expect(settings.extraKnownMarketplaces).toBeUndefined();
  });

  it("writes it once a human approves", () => {
    keel(["init"], repo.root);
    repo.write(
      "upstream.lock",
      `${lockWithMarketplace}\n    install: "echo plugin marketplace add owner/demo#v1.0.0"\n`,
    );

    keel(["upstream", "install", "--yes"], repo.root);
    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { extraKnownMarketplaces?: Record<string, unknown> };
    expect(settings.extraKnownMarketplaces?.["demo-market"]).toBeDefined();
  });

  it("does not declare anything when the install failed", () => {
    keel(["init"], repo.root);
    repo.write(
      "upstream.lock",
      `${lockWithMarketplace}\n    install: "echo plugin marketplace add owner/demo#v1.0.0 && exit 3"\n`,
    );

    const run = keel(["upstream", "install", "--yes"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("not declaring");

    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { extraKnownMarketplaces?: Record<string, unknown> };
    expect(settings.extraKnownMarketplaces).toBeUndefined();
  });
});

describe("phase ownership audit is honest", () => {
  it("does not double-count a claim when the repo is the plugin", () => {
    const run = keel(["check"], PLUGIN_ROOT);
    expect(run.stdout).toMatch(/no conflicts across \d+ declared claims?/);
    expect(run.stdout).not.toContain("across 2 declared claims");
  });

  it("says what it actually inspected", () => {
    const run = keel(["check"], PLUGIN_ROOT);
    expect(run.stdout).toContain("inspected");
    expect(run.stdout).toContain("not visible here");
  });
});

describe("review record", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("rejects a non-numeric comment count rather than recording 0", () => {
    // This is the project's headline metric; coercing `abc` to 0 reports a
    // clean PR that was never measured.
    const run = keel(
      ["review", "record", "--track", "standard", "--human-comments", "abc"],
      repo.root,
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--human-comments abc");
    expect(run.stderr).toContain("nothing was recorded");
  });

  it.each([["--bot-comments"], ["--reviews"], ["--changed-files"]])(
    "rejects a non-numeric %s too",
    (flag) => {
      const run = keel(["review", "record", "--track", "quick", flag, "seven"], repo.root);
      expect(run.status).toBe(1);
    },
  );

  it("records real numbers", () => {
    const run = keel(
      ["review", "record", "--track", "standard", "--human-comments", "4", "--reviews", "2", "--json"],
      repo.root,
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { humanComments: number; reviews: number };
    expect(parsed.humanComments).toBe(4);
    expect(parsed.reviews).toBe(2);
  });
});

describe("route with an unreadable config", () => {
  it("warns instead of silently running on defaults", () => {
    keel(["init"], repo.root);
    repo.commit("init keel");
    repo.write("keel.config.yaml", "version: 1\nrouter:\n  force_full_globs: [ unterminated\n");
    repo.write("README.md", "# a\n\nb\n");

    const run = keel(["route"], repo.root);
    expect(run.stdout).toContain("not valid YAML");
    expect(run.stdout).toContain("force_full_globs");
    // check and doctor already flagged this; route was the silent one.
    expect(keel(["check"], repo.root).status).toBe(1);
  });

  it("carries the warning into --json", () => {
    keel(["init"], repo.root);
    repo.commit("init keel");
    repo.write("keel.config.yaml", "version: 1\nrouter:\n  force_full_globs: [ unterminated\n");

    const parsed = JSON.parse(keel(["route", "--json"], repo.root).stdout) as {
      configWarning?: string;
    };
    expect(parsed.configWarning).toContain("defaults");
  });
});

// ---------------------------------------------------------------------------
// keel gate
// ---------------------------------------------------------------------------

describe("keel gate", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("runs the standards gates outside the editing loop", () => {
    // runGates had exactly one caller — the PostToolUse hook — so a change made
    // in any other editor, or in CI, bypassed the gates entirely.
    const run = keel(["gate"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Standards gates");
  });

  it("blocks on a high-severity finding in a changed line", () => {
    repo.write(
      "standards/no-todo-marker/standard.yaml",
      [
        "name: no-todo-marker",
        "owner: platform",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: Tracking markers do not belong in shipped source.",
        "",
      ].join("\n"),
    );
    repo.write(
      "standards/no-todo-marker/rule.ts",
      [
        "export default function rule(context) {",
        "  const out = [];",
        "  context.source.split('\\n').forEach((line, i) => {",
        "    if (line.includes('BANNED_MARKER')) {",
        "      out.push({ line: i + 1, message: 'tracking marker in source', fix: 'file an issue instead' });",
        "    }",
        "  });",
        "  return out;",
        "}",
        "",
      ].join("\n"),
    );
    repo.commit("add pack");
    // Repo-local rules do not run until a human approves them.
    expect(keel(["trust", "add", "no-todo-marker"], repo.root).status).toBe(0);

    repo.write("src/thing.ts", "export const a = 1; // BANNED_MARKER\n");

    const run = keel(["gate"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("src/thing.ts");
    expect(run.stdout).toContain("tracking marker in source");
    expect(run.stdout).toContain("fix: file an issue instead");
  });

  it("passes when the violation is on a line this change did not touch", () => {
    repo.write(
      "standards/no-todo-marker/standard.yaml",
      [
        "name: no-todo-marker",
        "owner: platform",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: Tracking markers do not belong in shipped source.",
        "",
      ].join("\n"),
    );
    repo.write(
      "standards/no-todo-marker/rule.ts",
      [
        "export default function rule(context) {",
        "  const out = [];",
        "  context.source.split('\\n').forEach((line, i) => {",
        "    if (line.includes('BANNED_MARKER')) {",
        "      out.push({ line: i + 1, message: 'tracking marker in source', fix: 'file an issue instead' });",
        "    }",
        "  });",
        "  return out;",
        "}",
        "",
      ].join("\n"),
    );
    repo.write("src/legacy.ts", "export const old = 1; // BANNED_MARKER\n");
    repo.commit("add pack and legacy code");
    expect(keel(["trust", "add", "no-todo-marker"], repo.root).status).toBe(0);

    repo.write("src/legacy.ts", "export const old = 1; // BANNED_MARKER\nexport const fresh = 2;\n");

    const run = keel(["gate"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no blocking findings");
  });

  it("emits machine-readable JSON for CI", () => {
    repo.write("src/thing.ts", "export const a = 1;\n");
    const run = keel(["gate", "--json"], repo.root);
    const parsed = JSON.parse(run.stdout) as {
      ok: boolean;
      blocking: unknown[];
      checkedFiles: number;
    };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.blocking)).toBe(true);
  });

  it("accepts a base ref", () => {
    repo.writeCommitted("src/thing.ts", "export const a = 1;\n");
    const run = keel(["gate", "--against", "HEAD~1"], repo.root);
    expect(run.status).toBe(0);
  });

  it("fails outside a git repository, with a fix", () => {
    const bare = mkdtempSync(join(tmpdir(), "keel-nogit-"));
    try {
      const run = keel(["gate"], bare);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("git init");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// keel trust
// ---------------------------------------------------------------------------

describe("keel trust", () => {
  const localPack = (name: string): void => {
    repo.write(
      `standards/${name}/standard.yaml`,
      [
        `name: ${name}`,
        "owner: local",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: A repo-local rule that runs on edit.",
        "",
      ].join("\n"),
    );
    repo.write(`standards/${name}/rule.ts`, "export default () => [];\n");
  };

  beforeEach(() => {
    keel(["init"], repo.root);
  });

  it("reports nothing to approve in a repo with no local packs", () => {
    const run = keel(["trust"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ships with the plugin");
  });

  // keel: allow-test-change the exit-code assertion here was `toBe(1)`, and
  // that was the defect: a read-only listing command that fails whenever
  // anything is unapproved aborts any `set -e` script that tries to *show* the
  // developer what needs approving. Failing on an unapproved pack is `keel
  // gate`'s job, asserted below and unchanged.
  it("lists an unapproved repo-local rule with its path and hash, and still exits 0", () => {
    localPack("house-style");
    const run = keel(["trust", "list"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("house-style");
    expect(run.stdout).toContain("standards/house-style/rule.ts");
    expect(run.stdout).toContain("sha256:");
    expect(run.stdout).toContain("keel trust add house-style");
  });

  it("says which command does fail on an unapproved rule", () => {
    localPack("house-style");
    expect(keel(["trust", "list"], repo.root).stdout).toContain("`keel gate` is the command that fails");
  });

  it("exits 0 from --json too, with the same counts", () => {
    localPack("house-style");
    const run = keel(["trust", "list", "--json"], repo.root);
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { untrustedCount: number }).untrustedCount).toBe(1);
  });

  it("survives `set -e`, which is what the exit code broke", () => {
    // The listing is the first thing a setup script runs; under `set -e` an
    // exit 1 killed the script before it could print the packs to approve.
    localPack("house-style");
    const script = spawnSync(
      "sh",
      ["-euc", `"$1" "$2" trust list > /dev/null && echo REACHED`, "sh", process.execPath, CLI],
      {
        cwd: repo.root,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, NO_COLOR: "1", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      },
    );
    expect(script.stdout).toContain("REACHED");
    expect(script.status).toBe(0);
  });

  it("leaves `keel gate` failing on the same unapproved rule", () => {
    localPack("house-style");
    repo.commit("add repo-local pack");
    repo.write("src/thing.ts", "export const a = 1;\n");
    expect(keel(["gate"], repo.root).status).toBe(1);
  });

  it("approves a rule, and check stops warning about it", () => {
    localPack("house-style");
    expect(keel(["check"], repo.root).stdout).toContain("`house-style` will not run");

    const add = keel(["trust", "add", "house-style"], repo.root);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("approved");

    expect(keel(["trust", "list"], repo.root).status).toBe(0);
    expect(keel(["check"], repo.root).stdout).not.toContain("will not run");
  });

  it("refuses to approve without a pack name", () => {
    localPack("house-style");
    const run = keel(["trust", "add"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("needs a pack name");
  });

  it("emits JSON", () => {
    localPack("house-style");
    const parsed = JSON.parse(keel(["trust", "list", "--json"], repo.root).stdout) as {
      untrustedCount: number;
      untrusted: Array<{ pack: string; file: string; sha256: string }>;
      packs: Array<{ pack: string; trusted: boolean }>;
    };
    expect(parsed.untrustedCount).toBe(1);
    expect(parsed.packs[0]).toEqual({ pack: "house-style", trusted: false });
    expect(parsed.untrusted[0]?.file).toBe("standards/house-style/rule.ts");
    expect(parsed.untrusted[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// --json across the commands CI wires up
// ---------------------------------------------------------------------------

describe("--json", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
  });

  it("is honoured by check", () => {
    const run = keel(["check", "--json"], repo.root);
    const parsed = JSON.parse(run.stdout) as { ok: boolean; errors: number; findings: unknown[] };
    expect(typeof parsed.ok).toBe("boolean");
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  it("is honoured by doctor", () => {
    const parsed = JSON.parse(keel(["doctor", "--json"], repo.root).stdout) as {
      version: string;
      packs: unknown[];
    };
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(parsed.packs)).toBe(true);
  });

  it("is honoured by review", () => {
    repo.write("README.md", "# a\n\nb\n");
    const parsed = JSON.parse(keel(["review", "--json"], repo.root).stdout) as { files: string[] };
    expect(parsed.files).toContain("README.md");
  });

  it("is honoured by gotchas", () => {
    const parsed = JSON.parse(keel(["gotchas", "--json"], repo.root).stdout) as {
      candidates: unknown[];
      written: number;
    };
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(parsed.written).toBe(0);
  });

  it("is honoured by telemetry", () => {
    const parsed = JSON.parse(keel(["telemetry", "show", "--json"], repo.root).stdout) as {
      events: number;
    };
    expect(typeof parsed.events).toBe("number");
  });

  it("is rejected, not ignored, where it is unsupported", () => {
    const run = keel(["init", "--json"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--json");
  });

  it("makes check's exit code and its JSON agree", () => {
    repo.write("keel.config.yaml", "version: 1\nrepo:\n  languages: [typescript]\n");
    const run = keel(["check", "--json"], repo.root);
    expect(run.status).toBe(1);
    const parsed = JSON.parse(run.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });
});

describe("gotchas without a terminal", () => {
  it("says so rather than doing nothing invisibly", () => {
    // Under a pipe the prompts resolved against a closed stdin: a prompt or two
    // appeared, nothing was written, and it exited 0 with no summary.
    keel(["init"], repo.root);
    repo.writeCommitted(
      "src/thing.ts",
      "// careful: the order of these two calls matters a great deal\nexport const a = 1;\n",
    );

    const run = keel(["gotchas"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("evidence");
    expect(run.stdout).toContain("not a terminal");
    expect(run.stdout).toContain("--list");
  });
});

describe("doctor's first run", () => {
  it("does not call the router miscalibrated off a handful of decisions", () => {
    keel(["init"], repo.root);
    repo.commit("init keel");
    repo.write("db/migrations/0001.sql", "CREATE TABLE t (id TEXT);");
    keel(["route"], repo.root);

    const run = keel(["doctor"], repo.root);
    expect(run.stdout).not.toContain("router is miscalibrated");
    expect(run.stdout).toContain("too few to judge calibration");
  });
});

describe("gate and trust together", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.commit("init keel");
    repo.write(
      "standards/needs-approval/standard.yaml",
      [
        "name: needs-approval",
        "owner: local",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: A repo-local rule that runs on edit.",
        "",
      ].join("\n"),
    );
    repo.write("standards/needs-approval/rule.ts", "export default () => [];\n");
    repo.commit("add repo-local pack");
    repo.write("src/thing.ts", "export const a = 1;\n");
  });

  it("fails rather than reporting a pass for a gate that never ran", () => {
    // "the gates passed" and "the gates did not run" must not be the same
    // observable state — that is the single worst thing a gate can do.
    const run = keel(["gate"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("did not run");
    expect(run.stdout).toContain("keel trust add needs-approval");
  });

  it("passes once the rule is approved", () => {
    expect(keel(["trust", "add", "needs-approval"], repo.root).status).toBe(0);
    const run = keel(["gate"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no blocking findings");
  });

  it("names the unapproved packs in --json", () => {
    const parsed = JSON.parse(keel(["gate", "--json"], repo.root).stdout) as {
      ok: boolean;
      untrusted: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.untrusted).toContain("needs-approval");
  });

  // The seam between two fixes. Requiring approval protects a developer's
  // machine; running the gates in CI is what stops a change written outside
  // Claude Code from skipping every org rule. Composed naively they cancel:
  // a runner cannot approve anything and cannot keep a signing key, so every
  // repo-local pack reports unapproved and CI is permanently red, advising a
  // machine to run a command only a human can. CI opts out explicitly.
  it("runs repo-local rules under --trust-repo-rules, the way CI does", () => {
    const run = keel(["gate", "--trust-repo-rules"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("did not run");
    expect(run.stdout).toContain("no blocking findings");
  });

  it("still catches a real violation under --trust-repo-rules", () => {
    // The flag must not become a way to make the gates stop firing — that
    // would be a worse bug than the one it fixes.
    repo.write(
      "standards/needs-approval/rule.ts",
      "export default (ctx) => ctx.source.includes('BANNED')\n" +
        "  ? [{ line: 1, message: 'banned token' }]\n  : [];\n",
    );
    repo.commit("rule that actually fires");
    repo.write("src/thing.ts", "export const a = 'BANNED';\n");

    const run = keel(["gate", "--trust-repo-rules"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("banned token");
  });

  it("does not print `fix: undefined` when a rule supplies no fix", () => {
    repo.write(
      "standards/needs-approval/rule.ts",
      "export default () => [{ line: 1, message: 'no fix offered' }];\n",
    );
    repo.commit("rule without a fix");
    repo.write("src/thing.ts", "export const a = 2;\n");

    const run = keel(["gate", "--trust-repo-rules"], repo.root);
    expect(run.stdout).toContain("no fix offered");
    expect(run.stdout).not.toContain("undefined");
  });
});

describe("the reviewer subagent is registered exactly once", () => {
  it("installs into .claude/agents/, where permissionMode is supported", () => {
    keel(["init"], repo.root);
    const installed = join(repo.root, ".claude", "agents", "keel-reviewer.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toContain("permissionMode: acceptEdits");
  });

  it("is not also sitting in the plugin's auto-scanned agents/ directory", () => {
    // Claude Code auto-discovers <plugin>/agents/ when plugin.json declares no
    // `agents` key, and plugin-shipped agents may not set `permissionMode`. A
    // copy there was a second, invalid registration of the same subagent.
    expect(existsSync(join(PLUGIN_ROOT, "agents", "keel-reviewer.md"))).toBe(false);
  });

  it("keeps exactly one template, outside every auto-scanned path", () => {
    // `installAgents` reads `templates/agents/` first and falls back to
    // `src/cli/templates/agents/`, so the file may live in either without a
    // code change. What must never be true is that it lives in neither, or in
    // the plugin-root `agents/` directory Claude Code scans by itself.
    const homes = [
      join(PLUGIN_ROOT, "templates", "agents", "keel-reviewer.md"),
      join(PLUGIN_ROOT, "src", "cli", "templates", "agents", "keel-reviewer.md"),
    ];
    expect(homes.filter(existsSync)).toHaveLength(1);
  });

  it("leaves a hand-edited copy alone", () => {
    keel(["init"], repo.root);
    const installed = join(repo.root, ".claude", "agents", "keel-reviewer.md");
    repo.write(".claude/agents/keel-reviewer.md", `${readFileSync(installed, "utf8")}\n## Mine\n`);
    keel(["init"], repo.root);
    expect(readFileSync(installed, "utf8")).toContain("## Mine");
  });
});

describe("doctor's budget breaches", () => {
  it("explains the `!`, and names cold cache before blaming a regression", () => {
    keel(["init"], repo.root);
    repo.write(
      ".keel/telemetry/events-2026-08-02.jsonl",
      `${JSON.stringify({
        ts: "2026-08-02T18:34:49.533Z",
        version: "0.1.0",
        repo_id: "x",
        session: "s",
        kind: "hook_timing",
        hook: "post-tool-use",
        duration_ms: 1400,
        loaded_ast: true,
      })}\n`,
    );

    const run = keel(["doctor"], repo.root);
    expect(run.stdout).toContain("! marks p95 over budget");
    expect(run.stdout).toContain("cold");
    expect(run.stdout).toContain("fix if it persists warm");
  });
});

// ---------------------------------------------------------------------------
// keel doctor --reset-tdd
// ---------------------------------------------------------------------------

interface StoredExpectation {
  readonly writtenAt: number;
  readonly redObservedAt: number | null;
  readonly failingTests: readonly string[];
}

interface StoredBranch {
  readonly expectations: Readonly<Record<string, StoredExpectation>>;
  readonly implemented: readonly string[];
}

/**
 * Seed the observed-RED ledger by writing the snapshot the module reads.
 *
 * A real file in a real repository, in the format `src/tdd/state.ts` defines —
 * the same shape the PostToolUse hook leaves behind after a developer writes a
 * test and watches it fail. Driving four hook invocations to produce it would
 * assert the hook, not the flag.
 */
function seedTddState(target: TempRepo, branches: Readonly<Record<string, StoredBranch>>): void {
  target.write(".keel/tdd-state.json", `${JSON.stringify({ version: 1, branches }, null, 2)}\n`);
}

function storedBranches(target: TempRepo): string[] {
  const raw = JSON.parse(readFileSync(join(target.root, ".keel", "tdd-state.json"), "utf8")) as {
    branches: Record<string, unknown>;
  };
  return Object.keys(raw.branches);
}

const RED: StoredExpectation = { writtenAt: 1000, redObservedAt: 2000, failingTests: ["earned it"] };
const NOT_RED: StoredExpectation = { writtenAt: 5000, redObservedAt: null, failingTests: [] };

describe("doctor --reset-tdd", () => {
  let branch: string;

  beforeEach(() => {
    keel(["init"], repo.root);
    branch = repo.git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    seedTddState(repo, {
      [branch]: {
        expectations: { "src/a.test.ts": RED, "src/b.test.ts": NOT_RED },
        implemented: ["src/a.ts#a"],
      },
      stale: { expectations: { "src/c.test.ts": RED }, implemented: [] },
    });
  });

  it("exists at all — `state.ts` named this flag before it did", () => {
    // `writeState` and `clearBranch` had no production caller, and their doc
    // comments pointed at a `keel doctor --reset-tdd` that did not exist.
    expect(keel(["help"], repo.root).stdout).toContain("--reset-tdd");
    expect(keel(["doctor", "--reset-tdd"], repo.root).status).toBe(0);
  });

  it("clears every branch, and says how many it affected", () => {
    const run = keel(["doctor", "--reset-tdd"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("TDD ledger reset");
    expect(run.stdout).toContain("2 branches");
    expect(run.stdout).toContain("3 test files");
    expect(storedBranches(repo)).toEqual([]);
  });

  it("does not do it silently — deleting a RED re-blocks the next new export", () => {
    const run = keel(["doctor", "--reset-tdd"], repo.root);
    // Two of the three had a valid observed RED (`stale` and the current branch).
    expect(run.stdout).toContain("valid observed RED");
    expect(run.stdout).toContain("earned again");
    expect(run.stdout).toContain("watch it fail before implementing");
  });

  it("clears one named branch and leaves the rest alone", () => {
    const run = keel(["doctor", "--reset-tdd", "stale"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("cleared `stale`");
    expect(keel(["doctor", "--json"], repo.root).status).toBe(0);

    // The current branch's expectations survive, and doctor still reports them.
    const after = keel(["doctor"], repo.root).stdout;
    expect(after).toContain("src/a.test.ts");
    expect(after).toContain("red observed");
  });

  it("accepts the --reset-tdd=<branch> spelling too", () => {
    expect(keel(["doctor", "--reset-tdd=stale"], repo.root).stdout).toContain("cleared `stale`");
  });

  it("says so when the named branch had nothing recorded", () => {
    const run = keel(["doctor", "--reset-tdd", "never-existed"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("nothing recorded");
    expect(storedBranches(repo).sort()).toEqual([branch, "stale"].sort());
  });

  it("reports the reset in --json rather than only on the terminal", () => {
    const parsed = JSON.parse(keel(["doctor", "--reset-tdd", "--json"], repo.root).stdout) as {
      tddReset: { branch: string | null; branches: number; expectations: number; observedRed: number };
    };
    expect(parsed.tddReset).toEqual({
      branch: null,
      branches: 2,
      expectations: 3,
      observedRed: 2,
    });
  });

  it("is never implied by a plain `keel doctor`", () => {
    // Reporting on the ledger must not be a way to destroy it.
    keel(["doctor"], repo.root);
    keel(["doctor", "--json"], repo.root);
    expect(storedBranches(repo).sort()).toEqual([branch, "stale"].sort());
    expect(JSON.parse(keel(["doctor", "--json"], repo.root).stdout)).toHaveProperty("tddReset", null);
  });

  it("drops the journal with the snapshot, so cleared records cannot come back", () => {
    repo.write(
      ".keel/tdd-state.log",
      `${JSON.stringify({ kind: "red", branch, files: ["src/d.test.ts"], at: 7000, failingTests: [] })}\n`,
    );
    keel(["doctor", "--reset-tdd"], repo.root);
    expect(existsSync(join(repo.root, ".keel", "tdd-state.log"))).toBe(false);
    expect(keel(["doctor"], repo.root).stdout).toContain("no test expectations recorded");
  });

  it("rejects an empty value, and names both ways to spell it", () => {
    const run = keel(["doctor", "--reset-tdd="], repo.root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("empty value");
    expect(run.stderr).toContain("drop the `=`");
    expect(storedBranches(repo)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// keel init writes every section it reads
// ---------------------------------------------------------------------------

describe("init writes the whole config", () => {
  beforeEach(() => {
    repo.write("package.json", JSON.stringify({ name: "demo" }));
    keel(["init"], repo.root);
  });

  const generated = (): string => readFileSync(join(repo.root, "keel.config.yaml"), "utf8");

  it("emits all ten sections, not six", () => {
    // It wrote version, repo, tracks, router, standards, tdd and telemetry, and
    // left upstream, display, spec and mutation undiscoverable.
    const top = new Set(
      generated()
        .split("\n")
        .filter((l) => /^[a-z_]+:/.test(l))
        .map((l) => l.slice(0, l.indexOf(":"))),
    );
    expect([...top].sort()).toEqual(
      [
        "display",
        "mutation",
        "repo",
        "router",
        "spec",
        "standards",
        "tdd",
        "telemetry",
        "tracks",
        "upstream",
        "version",
      ].sort(),
    );
  });

  it("emits the fields that were missing from the sections it did write", () => {
    const text = generated();
    for (const key of [
      "standard_max_files:",
      "standard_max_lines:",
      "package_roots:",
      "dirs:",
      "test_globs:",
      "test_command:",
    ]) {
      expect(text, key).toContain(key);
    }
  });

  it("makes `mutation.test_command` discoverable somewhere other than an error", () => {
    expect(generated()).toContain("test_command");
    expect(generated()).toContain("Detected from the repo when empty");
  });

  it("explains every knob it writes — a config nobody understands is one nobody tunes", () => {
    const text = generated();
    for (const comment of [
      "# Any change touching these is always full track.",
      "# Past either of these a change is full track on size alone",
      "# Monorepo layout",
      "# Where packs are looked for",
      "# What counts as a test file",
      "# Superpowers skills Keel switches on",
      "# Formatting past this budget is dropped",
      "# Root of the OpenSpec working tree.",
      "# Floor for killed/total on changed lines",
    ]) {
      expect(text, comment).toContain(comment);
    }
  });

  it("writes the values Keel actually falls back to, so the file cannot lie", () => {
    // The scaffold is generated from `defaultConfig`, so a default that moves in
    // one place and not the other fails here rather than misleading a reader.
    const parsed = validateConfig(parseYaml(generated()));
    expect(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.error)).toBe(true);
    if (!parsed.ok) return;

    const expected = defaultConfig(parsed.value.repo.name, parsed.value.repo.languages);
    expect(parsed.value).toEqual({
      ...expected,
      // The one deliberate departure: the scaffold seeds force-full paths, which
      // default to empty because Keel cannot guess a repository's danger zones.
      router: { ...expected.router, force_full_globs: parsed.value.router.force_full_globs },
    });
    expect(parsed.value.router.force_full_globs).toContain("**/migrations/**");
  });

  it("still passes keel check unchanged", () => {
    const run = keel(["check"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("keel.config.yaml valid");
  });

  it("is still byte-identical on a second and third run", () => {
    const first = generated();
    keel(["init"], repo.root);
    keel(["init"], repo.root);
    expect(generated()).toBe(first);
  });

  it("still keeps a hand-edited config, larger file or not", () => {
    repo.write("keel.config.yaml", `${generated()}\n# my note\n`);
    keel(["init"], repo.root);
    expect(generated()).toContain("# my note");
  });
});

// ---------------------------------------------------------------------------
// The untrusted path, from a consumer repository with no machine key
// ---------------------------------------------------------------------------

/**
 * Keel is its own plugin, so in this repository `pluginRoot === repoRoot` and
 * `isPluginPack` treats `standards/` as shipped-with-Keel. Its own CI therefore
 * only ever exercised the *trusted* path, which is exactly how "`keel gate`
 * fails every consumer build with advice a runner cannot take" survived a
 * review pass. These tests are consumer-shaped on both axes that matter: a repo
 * that is not the plugin root, and a `KEEL_HOME` with no machine key in it, so
 * no approval can exist and none can be inherited from the developer running
 * the suite.
 */
describe("a consumer repository, with no machine key of its own", () => {
  let home: string;

  const PACK = "house-rules";

  const consumerEnv = (): Record<string, string> => ({ KEEL_HOME: home });

  const writePack = (rule: string): void => {
    repo.write(
      `standards/${PACK}/standard.yaml`,
      [
        `name: ${PACK}`,
        "owner: local",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: A rule this repository ships and this checkout has not approved.",
        "",
      ].join("\n"),
    );
    repo.write(`standards/${PACK}/rule.ts`, rule);
  };

  const FIRES_ON_BANNED = [
    "export default function rule(context) {",
    "  const out = [];",
    "  context.source.split('\\n').forEach((line, i) => {",
    "    if (line.includes('BANNED')) {",
    "      out.push({ line: i + 1, message: 'banned token', fix: 'remove it' });",
    "    }",
    "  });",
    "  return out;",
    "}",
    "",
  ].join("\n");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "keel-home-"));
    keel(["init"], repo.root, consumerEnv());
    writePack(FIRES_ON_BANNED);
    repo.commit("consumer repo with its own pack");
    repo.write("src/thing.ts", "export const a = 1;\n");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("is genuinely consumer-shaped: not the plugin root, and no key on this machine", () => {
    // Both halves of the premise. Without them the assertions below pass for
    // the wrong reason — the pack would be plugin-shipped, or an approval the
    // developer made years ago would already be on disk.
    expect(repo.root).not.toBe(PLUGIN_ROOT);
    expect(existsSync(join(home, "machine-key"))).toBe(false);
    expect(existsSync(join(repo.root, ".keel", "trust.json"))).toBe(false);
    const parsed = JSON.parse(keel(["trust", "list", "--json"], repo.root, consumerEnv()).stdout) as {
      packs: Array<{ pack: string; trusted: boolean }>;
    };
    expect(parsed.packs).toEqual([{ pack: PACK, trusted: false }]);
  });

  it("fails the gate, and names the command that fixes it", () => {
    const run = keel(["gate"], repo.root, consumerEnv());
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("did not run");
    expect(run.stdout).toContain(`keel trust add ${PACK}`);
  });

  it("the named fix works, and creates the key it signs with", () => {
    // Every error message in this codebase names the fix; this is the assertion
    // that the fix, followed exactly, actually clears the failure.
    const add = keel(["trust", "add", PACK], repo.root, consumerEnv());
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("approved");
    expect(existsSync(join(home, "machine-key"))).toBe(true);

    const run = keel(["gate"], repo.root, consumerEnv());
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no blocking findings");
  });

  it("runs the rule under --trust-repo-rules, with no approval anywhere", () => {
    // CI cannot approve anything and cannot keep a signing key. Without this
    // flag the two fixes cancel and every consumer build is permanently red.
    const run = keel(["gate", "--trust-repo-rules"], repo.root, consumerEnv());
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("did not run");

    // And it granted nothing on the way through: no approval was recorded, so
    // the next run without the flag is untrusted again. The flag is a decision
    // made per invocation, not a door left open.
    expect(existsSync(join(repo.root, ".keel", "trust.json"))).toBe(false);
    expect(keel(["gate"], repo.root, consumerEnv()).status).toBe(1);
  });

  it("still blocks a real violation under --trust-repo-rules", () => {
    // The flag must not become a way to make the gates stop firing.
    repo.write("src/thing.ts", "export const bad = 'BANNED';\n");
    const run = keel(["gate", "--trust-repo-rules"], repo.root, consumerEnv());
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("banned token");
    expect(run.stdout).toContain("fix: remove it");
  });

  it("still blocks a real violation once approved the ordinary way", () => {
    keel(["trust", "add", PACK], repo.root, consumerEnv());
    repo.write("src/thing.ts", "export const bad = 'BANNED';\n");
    const run = keel(["gate"], repo.root, consumerEnv());
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("banned token");
  });

  it("re-blocks when the approved rule is edited, since trust is in the bytes", () => {
    keel(["trust", "add", PACK], repo.root, consumerEnv());
    expect(keel(["gate"], repo.root, consumerEnv()).status).toBe(0);

    writePack(FIRES_ON_BANNED.replace("banned token", "banned token (v2)"));
    const run = keel(["gate"], repo.root, consumerEnv());
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("did not run");
  });

  it("does not accept an approval another machine wrote", () => {
    // The interesting hostile case: a repository that commits its own
    // `.keel/trust.json`. Approve under one home, then arrive with another.
    keel(["trust", "add", PACK], repo.root, consumerEnv());
    const other = mkdtempSync(join(tmpdir(), "keel-home-other-"));
    try {
      const run = keel(["gate"], repo.root, { KEEL_HOME: other });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("did not run");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("records `untrusted` in telemetry, not `error`", () => {
    // `gateStats` counts every gate event as a run and only `fail` as a failure,
    // so folding these into `error` made `keel doctor` say "has never fired in
    // 20 runs — consider deleting it" about a pack that was never allowed to run.
    keel(["gate"], repo.root, consumerEnv());
    const events = readSpooledEvents(repo);
    const mine = events.filter((e) => e.kind === "gate" && e.pack === PACK);
    expect(mine).not.toHaveLength(0);
    expect(mine.map((e) => e.result)).toContain("untrusted");
    expect(mine.map((e) => e.result)).not.toContain("error");
  });

  it("still records `error` for a rule that genuinely breaks", () => {
    // The distinction is only worth anything if `error` still means something.
    writePack("export default () => { throw new Error('rule exploded'); };\n");
    keel(["trust", "add", PACK], repo.root, consumerEnv());
    keel(["gate"], repo.root, consumerEnv());

    const results = readSpooledEvents(repo)
      .filter((e) => e.kind === "gate" && e.pack === PACK)
      .map((e) => e.result);
    expect(results).toContain("error");
    expect(results).not.toContain("untrusted");
  });

  it("records `pass` for a pack that ran and found nothing", () => {
    keel(["trust", "add", PACK], repo.root, consumerEnv());
    keel(["gate"], repo.root, consumerEnv());
    const results = readSpooledEvents(repo)
      .filter((e) => e.kind === "gate" && e.pack === PACK)
      .map((e) => e.result);
    expect(results).toContain("pass");
  });
});

interface SpooledEvent {
  readonly kind: string;
  readonly pack?: string;
  readonly result?: string;
}

/** Every telemetry event on disk, oldest file first. */
function readSpooledEvents(target: TempRepo): SpooledEvent[] {
  const dir = join(target.root, ".keel", "telemetry");
  if (!existsSync(dir)) return [];
  const out: SpooledEvent[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("events-") || !name.endsWith(".jsonl")) continue;
    for (const raw of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      out.push(JSON.parse(raw) as SpooledEvent);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// keel gate --against reads one side, and says which
// ---------------------------------------------------------------------------

describe("gate --against reads the same side it measures", () => {
  beforeEach(() => {
    keel(["init"], repo.root);
    repo.write(
      "standards/no-banned/standard.yaml",
      [
        "name: no-banned",
        "owner: local",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: The token BANNED does not belong in shipped source.",
        "",
      ].join("\n"),
    );
    repo.write(
      "standards/no-banned/rule.ts",
      [
        "export default function rule(context) {",
        "  const out = [];",
        "  context.source.split('\\n').forEach((line, i) => {",
        "    if (line.includes('BANNED')) {",
        "      out.push({ line: i + 1, message: 'banned token', fix: 'remove it' });",
        "    }",
        "  });",
        "  return out;",
        "}",
        "",
      ].join("\n"),
    );
    repo.write("src/thing.ts", "export const a = 1;\n");
    repo.commit("baseline");
    expect(keel(["trust", "add", "no-banned"], repo.root).status).toBe(0);
  });

  /** HEAD adds the violation on line 2; the working tree then shifts it to 3. */
  const shiftedWorkingTree = (): void => {
    repo.write("src/thing.ts", 'export const a = 1;\nexport const b = "BANNED";\n');
    repo.commit("add violation");
    repo.write(
      "src/thing.ts",
      'export const zero = 0;\nexport const a = 1;\nexport const b = "BANNED";\n',
    );
  };

  it("finds the violation at HEAD's line number, not the working tree's", () => {
    // The changed-line set comes from `<ref>...HEAD`, so line 2 is the only line
    // a finding may land on. Reading the text from the working tree put BANNED
    // on line 3, which the diff-only filter then dropped — a false green, and
    // the sort of thing that only shows up when the tree is dirty.
    shiftedWorkingTree();
    const run = keel(["gate", "--against", "HEAD~1"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("src/thing.ts:2");
    expect(run.stdout).toContain("banned token");
  });

  it("says which side it read", () => {
    shiftedWorkingTree();
    const run = keel(["gate", "--against", "HEAD~1"], repo.root);
    expect(run.stdout).toContain("read at HEAD");
    expect(run.stdout).toContain("HEAD~1...HEAD");
  });

  it("names the files whose working-tree copy it did not judge", () => {
    shiftedWorkingTree();
    const run = keel(["gate", "--against", "HEAD~1"], repo.root);
    expect(run.stdout).toContain("uncommitted changes");
    expect(run.stdout).toContain("src/thing.ts");
    expect(run.stdout).toContain("keel gate` with no --against");
  });

  it("says nothing about uncommitted work on a clean checkout, which is CI", () => {
    repo.write("src/thing.ts", 'export const a = 1;\nexport const b = "fine";\n');
    repo.commit("clean change");
    const run = keel(["gate", "--against", "HEAD~1"], repo.root);
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("uncommitted changes");
    expect(run.stdout).toContain("read at HEAD");
  });

  it("carries both facts into --json", () => {
    shiftedWorkingTree();
    const parsed = JSON.parse(keel(["gate", "--against", "HEAD~1", "--json"], repo.root).stdout) as {
      contentsAt: string;
      uncommitted: string[];
      blocking: Array<{ line: number; path: string }>;
    };
    expect(parsed.contentsAt).toBe("HEAD");
    expect(parsed.uncommitted).toContain("src/thing.ts");
    expect(parsed.blocking[0]?.line).toBe(2);
  });

  it("still reads the working tree when no base ref is given", () => {
    // The hook's comparison, and the one a developer mid-edit needs: there the
    // working tree *is* the right-hand side of the diff.
    repo.write("src/thing.ts", 'export const a = 1;\nexport const b = "BANNED";\n');
    const run = keel(["gate"], repo.root);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("src/thing.ts:2");

    const parsed = JSON.parse(keel(["gate", "--json"], repo.root).stdout) as {
      contentsAt: string;
      uncommitted: string[];
    };
    expect(parsed.contentsAt).toBe("working tree");
    expect(parsed.uncommitted).toEqual([]);
  });
});

describe("keel init installs the plugin components from the checkout", () => {
  // There is no marketplace. `init` is the install, so what it writes has to be
  // exactly what Claude Code discovers on its own — and it has to be safe to
  // run twice, and safe to run in a repo where someone already wrote their own
  // hooks.
  interface HookCommand {
    readonly command?: string;
    readonly args?: readonly string[];
  }
  interface HookMatcher {
    readonly matcher?: string;
    readonly hooks?: readonly HookCommand[];
  }

  function localHooks(root: string): Record<string, HookMatcher[]> {
    const raw = readFileSync(join(root, ".claude", "settings.local.json"), "utf8");
    return (JSON.parse(raw) as { hooks?: Record<string, HookMatcher[]> }).hooks ?? {};
  }

  it("wires every hook event with an absolute path to this checkout", () => {
    keel(["init"], repo.root);
    const hooks = localHooks(repo.root);

    expect(Object.keys(hooks).sort()).toEqual([
      "MessageDisplay",
      "PostToolUse",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
    ]);

    const args = Object.values(hooks).flatMap((entries) =>
      entries.flatMap((e) => (e.hooks ?? []).flatMap((h) => h.args ?? [])),
    );
    expect(args.length).toBeGreaterThan(0);
    // `${CLAUDE_PLUGIN_ROOT}` is expanded for a plugin; nothing expands it in a
    // settings file, so an unresolved one here would be a hook that never runs.
    for (const arg of args) {
      expect(arg).not.toContain("CLAUDE_PLUGIN_ROOT");
      expect(arg.startsWith(PLUGIN_ROOT)).toBe(true);
    }
  });

  it("installs the skills and the output style where Claude Code finds them", () => {
    keel(["init"], repo.root);
    for (const name of ["keel-init", "keel-spec", "keel-standards"]) {
      expect(existsSync(join(repo.root, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(repo.root, ".claude", "output-styles", "keel.md"))).toBe(true);
  });

  it("does not select the output style — that is the developer's choice", () => {
    keel(["init"], repo.root);
    const settings = JSON.parse(
      readFileSync(join(repo.root, ".claude", "settings.json"), "utf8"),
    ) as { outputStyle?: string };
    expect(settings.outputStyle).toBeUndefined();
  });

  it("gitignores the local settings file, which names a machine-specific path", () => {
    keel(["init"], repo.root);
    const ignored = readFileSync(join(repo.root, ".gitignore"), "utf8");
    expect(ignored).toContain(".claude/settings.local.json");
  });

  it("adds no second copy when run again", () => {
    keel(["init"], repo.root);
    const before = localHooks(repo.root);
    const count = (h: Record<string, HookMatcher[]>): number =>
      Object.values(h).reduce((n, entries) => n + entries.length, 0);

    keel(["init"], repo.root);
    expect(count(localHooks(repo.root))).toBe(count(before));
  });

  it("keeps a hook the developer wrote", () => {
    keel(["init"], repo.root);
    const path = join(repo.root, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      hooks: Record<string, HookMatcher[]>;
    };
    settings.hooks["PostToolUse"] = [
      ...(settings.hooks["PostToolUse"] ?? []),
      { matcher: "Write", hooks: [{ command: "echo", args: ["mine"] }] },
    ];
    repo.write(".claude/settings.local.json", JSON.stringify(settings, null, 2));

    keel(["init"], repo.root);
    const after = localHooks(repo.root)["PostToolUse"] ?? [];
    expect(after.filter((e) => e.hooks?.[0]?.command === "echo")).toHaveLength(1);
  });

  it("ships no marketplace manifest", () => {
    // Removing it is the point: a marketplace is a second distribution channel
    // to keep in sync with the checkout you already have.
    expect(existsSync(join(PLUGIN_ROOT, ".claude-plugin", "marketplace.json"))).toBe(false);
  });
});
