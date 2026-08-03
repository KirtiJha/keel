import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * Properties that were true but unguarded — an audit deleted each one and the
 * whole suite stayed green.
 *
 * They are grouped here because they share a shape: each is a claim about what
 * happens at the *boundary* — the built bundle, a real git repo, a real
 * subprocess — and each was previously "tested" only at a layer that could not
 * observe it. A unit test of `redact()` says nothing about whether anything
 * calls it; a fail-open test with no pack and no file cannot tell a hook that
 * proceeds from one that had nothing to say.
 *
 * Every test here drives the shipped bundle and asserts on the exit code and
 * bytes Claude Code would actually see.
 */

const CLI = join(PLUGIN_ROOT, "scripts", "cli.mjs");
const POST_TOOL_USE = join(PLUGIN_ROOT, "scripts", "post-tool-use.mjs");

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function hook(repoRoot: string, filePath: string, env: NodeJS.ProcessEnv = {}): Run {
  const payload = JSON.stringify({
    session_id: "integrity",
    cwd: repoRoot,
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  });
  const result = spawnSync(process.execPath, [POST_TOOL_USE], {
    cwd: repoRoot,
    input: payload,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function keel(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: "1", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A gate pack that fires on every line, so "did it run" is unambiguous. */
function alwaysFiresPack(repo: TempRepo, name: string, message: string): void {
  repo.write(
    `standards/${name}/standard.yaml`,
    [
      `name: ${name}`,
      "owner: integrity",
      "mode: gate",
      "severity: high",
      "languages: [typescript]",
      'applies_to: ["src/**/*.ts"]',
      `description: ${message}`,
      "",
    ].join("\n"),
  );
  repo.write(
    `standards/${name}/rule.mjs`,
    `export default (ctx) =>\n` +
      `  ctx.source.split("\\n").map((l, i) => ({ line: i + 1, message: ${JSON.stringify(message)} }));\n`,
  );
}

let repo: TempRepo;

beforeAll(() => {
  if (!existsSync(POST_TOOL_USE)) throw new Error("missing bundles — run `npm run build` first");
});

beforeEach(() => {
  repo = TempRepo.create("keel-integrity-");
});

afterEach(() => {
  repo.dispose();
});

describe("the standards gate fails open when git cannot answer", () => {
  // The old test for this passed `cwd: "/tmp"` with no file path and no packs,
  // so the hook returned before it reached config, packs or git at all. It
  // asserted exit 0 in a scenario that could never have been 2. Replacing the
  // fail-open in the runner with a degrade-to-whole-file left the whole suite
  // green — which is what these three cases now prevent.
  beforeEach(() => {
    keel(["init"], repo.root);
    alwaysFiresPack(repo, "tripwire", "tripwire fired");
    repo.commit("pack and config");
    repo.writeCommitted("src/thing.ts", "export const a = 1;\nexport const b = 2;\n");
    keel(["trust", "add", "tripwire"], repo.root);
  });

  it("blocks a real violation — the positive control", () => {
    repo.write("src/thing.ts", "export const a = 1;\nexport const b = 3;\n");
    const run = hook(repo.root, join(repo.root, "src/thing.ts"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("tripwire fired");
  });

  it("proceeds when git is not on PATH, on a committed unedited file", () => {
    // A bare PATH containing only node: `git` cannot be spawned at all.
    const nodeDir = join(process.execPath, "..");
    const run = hook(repo.root, join(repo.root, "src/thing.ts"), { PATH: nodeDir });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("tripwire fired");
  });

  it("proceeds on a gitignored file, with git present and healthy", () => {
    // The likely-in-practice case: generated code blocked on every edit.
    repo.writeCommitted(".gitignore", ".keel/\nsrc/generated.ts\n");
    repo.write("src/generated.ts", "export const g = 1;\n");
    const run = hook(repo.root, join(repo.root, "src/generated.ts"));
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("tripwire fired");
  });

  it("proceeds when the git index is corrupt", () => {
    writeFileSync(join(repo.root, ".git", "index"), Buffer.alloc(4096, 0x41));
    const run = hook(repo.root, join(repo.root, "src/thing.ts"));
    expect(run.status).toBe(0);
  });
});

describe("secrets do not reach the model or the terminal", () => {
  // `redact` was wired into the debug log and telemetry — the two channels that
  // do NOT reach Claude — while the blocking reason that does was unprotected.
  // Nothing tested the wiring, only the function.
  //
  // Assembled at runtime: a literal token shape in a source file trips GitHub's
  // push protection.
  const FAKE_KEY = `sk-${"NOTAREAL"}${"0".repeat(24)}`;

  beforeEach(() => {
    keel(["init"], repo.root);
    repo.write(
      "standards/quoter/standard.yaml",
      [
        "name: quoter",
        "owner: integrity",
        "mode: gate",
        "severity: high",
        "languages: [typescript]",
        'applies_to: ["src/**/*.ts"]',
        "description: quotes the offending line, as most linters do",
        "",
      ].join("\n"),
    );
    repo.write(
      "standards/quoter/rule.mjs",
      "export default (ctx) =>\n" +
        "  ctx.source.split(\"\\n\").flatMap((l, i) =>\n" +
        "    l.includes(\"sk-\") ? [{ line: i + 1, message: `hardcoded secret: ${l}` }] : []);\n",
    );
    repo.commit("quoting pack");
    repo.writeCommitted("src/client.ts", "export const ok = 1;\n");
    keel(["trust", "add", "quoter"], repo.root);
  });

  it("keeps a secret out of the blocking reason fed back to Claude", () => {
    repo.write("src/client.ts", `export const KEY = "${FAKE_KEY}";\n`);
    const run = hook(repo.root, join(repo.root, "src/client.ts"));

    expect(run.status).toBe(2);
    // The finding still arrives — redaction must not silence the gate.
    expect(run.stderr).toContain("hardcoded secret");
    expect(run.stderr).toContain("[redacted]");
    expect(run.stderr).not.toContain(FAKE_KEY);
    expect(run.stdout).not.toContain(FAKE_KEY);
  });

  it("keeps a secret out of CLI output, including --json", () => {
    repo.write("src/client.ts", `export const KEY = "${FAKE_KEY}";\n`);

    const text = keel(["gate"], repo.root);
    expect(text.stdout + text.stderr).not.toContain(FAKE_KEY);

    const asJson = keel(["gate", "--json"], repo.root);
    expect(asJson.stdout).not.toContain(FAKE_KEY);
    // Still valid JSON: the replacement carries no quotes or backslashes.
    expect(() => JSON.parse(asJson.stdout) as unknown).not.toThrow();
  });
});

describe("keel mutate reads changed lines from the base ref it was given", () => {
  // The file list came from `--against` while the line set was hard-wired to
  // HEAD, so on a clean CI checkout every file yielded an empty set and the
  // gate reported a perfect score without testing anything. Reverting that one
  // argument left the suite green.
  it("generates mutants for a change that is already committed", () => {
    // A test command that passes and asserts nothing: every mutant will
    // survive, which is fine — this test is about whether any mutant is
    // *generated*, not about the score.
    repo.write(
      "package.json",
      JSON.stringify({ name: "m", scripts: { test: "node -e \"\"" } }, null, 2),
    );
    repo.writeCommitted("src/calc.js", "export function over(n) {\n  return n > 10;\n}\n");
    const base = repo.git(["rev-parse", "HEAD"]).trim();

    // A committed logic change, working tree clean — the CI shape exactly.
    repo.writeCommitted("src/calc.js", "export function over(n) {\n  return n > 20;\n}\n");

    const run = keel(["mutate", "--against", base, "--json", "--report"], repo.root);
    const report = JSON.parse(run.stdout) as { total: number; note?: string };

    expect(report.total).toBeGreaterThan(0);
    expect(report.note ?? "").not.toContain("no mutable changed lines");
    // The old bug produced exactly this shape: a clean tree, zero mutants, and
    // a perfect score reported as a pass.
    expect(report.note ?? "").not.toContain("the test suite is already failing");
  });
});

describe("diff-only never degrades to whole-file", () => {
  it("reports only the line this change touched, on a long file", () => {
    keel(["init"], repo.root);
    alwaysFiresPack(repo, "everyline", "everyline fired");
    repo.commit("pack");

    const original = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    repo.writeCommitted("src/many.ts", `${original}\n`);
    keel(["trust", "add", "everyline"], repo.root);

    // Change exactly one line out of forty.
    const edited = original.replace("export const v7 = 7;", "export const v7 = 700;");
    repo.write("src/many.ts", `${edited}\n`);

    const run = keel(["gate", "--json"], repo.root);
    const parsed = JSON.parse(run.stdout) as { blocking: Array<{ line: number }> };

    // A rule that fires on every line, filtered to the one that changed.
    expect(parsed.blocking.map((f) => f.line)).toEqual([8]);
  });
});

describe("a session id cannot escape the state directory", () => {
  // The old test round-tripped a hostile id through the sanitiser it was
  // testing, so a sanitiser that mapped the id somewhere outside the repo
  // would have passed identically. Assert where the file landed instead.
  it("writes spike state inside .keel, never above it", () => {
    const outside = mkdtempSync(join(tmpdir(), "keel-outside-"));
    try {
      keel(["init"], repo.root);
      const hostile = `../../../../../../${outside.replace(/^\//, "")}/pwned`;
      keel(["route"], repo.root, { KEEL_SPIKE: "1", CLAUDE_SESSION_ID: hostile });

      expect(existsSync(join(outside, "pwned"))).toBe(false);
      expect(existsSync(join(outside, "pwned.json"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("an unwritable .keel never turns into a blocked edit", () => {
  it("proceeds when the state directory cannot be written", () => {
    keel(["init"], repo.root);
    repo.writeCommitted("src/thing.ts", "export const a = 1;\n");

    const keelDir = join(repo.root, ".keel");
    chmodSync(keelDir, 0o500);
    try {
      const run = hook(repo.root, join(repo.root, "src/thing.ts"));
      expect(run.status).toBe(0);
      expect(() => JSON.parse(run.stdout) as unknown).not.toThrow();
    } finally {
      chmodSync(keelDir, 0o700);
    }
  });
});

describe("the built bundles carry no exit(1)", () => {
  // Exit 1 is non-blocking to Claude Code, so using it for policy would
  // silently turn every gate into a no-op. A static check is the honest test:
  // the behavioural one only covers whichever branch it happens to exercise.
  it("uses only exit(0) and exit(2)", () => {
    for (const name of [
      "session-start",
      "pre-tool-use",
      "post-tool-use",
      "post-bash",
      "message-display",
      "session-end",
    ]) {
      const source = readFileSync(join(PLUGIN_ROOT, "scripts", `${name}.mjs`), "utf8");
      const calls = [...source.matchAll(/process\.exit\(\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
      const literals = calls.filter((c) => /^\d+$/.test(c ?? ""));
      expect(literals, `${name}.mjs`).not.toContain("1");
    }
  });
});
