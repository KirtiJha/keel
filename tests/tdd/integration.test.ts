import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSpike } from "../../src/context/session-state.js";
import { runTddGates } from "../../src/tdd/index.js";
import {
  branchState,
  clearBranch,
  journalPath,
  readState,
  recordRedObserved,
  recordTestWritten,
  redObservedFor,
  statePath,
} from "../../src/tdd/state.js";
import { isTestCommand, parseTestOutput } from "../../src/tdd/test-run.js";
import { currentBranch } from "../../src/shared/git.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-tdd-int-");
});

afterEach(() => {
  repo.dispose();
});

const run = (filePath: string, sessionId = "s1") =>
  runTddGates({
    repoRoot: repo.root,
    pluginRoot: PLUGIN_ROOT,
    config: repo.config(),
    filePath,
    sessionId,
  });

describe("test-command recognition", () => {
  it.each([
    "npm test",
    "npm run test -- --watch=false",
    "pnpm test",
    "npx vitest run",
    "yarn jest src/",
    "pytest -q",
    "python -m pytest tests/",
    "make test",
  ])("recognises %s", (command) => {
    expect(isTestCommand(command)).toBe(true);
  });

  it.each(["npm run build", "git status", "ls -la", "npm run lint"])(
    "does not treat %s as a test run",
    (command) => {
      expect(isTestCommand(command)).toBe(false);
    },
  );
});

describe("test-output parsing", () => {
  it("reads vitest failures", () => {
    const output = [
      " ✓ src/ok.test.ts (2 tests)",
      " FAIL  src/auth/refresh.test.ts > refreshToken > rotates the token",
      "AssertionError: expected undefined to be 'abc'",
    ].join("\n");

    const outcome = parseTestOutput(output, 1);
    expect(outcome.failed).toBe(true);
    expect(outcome.failingFiles).toContain("src/auth/refresh.test.ts");
    expect(outcome.failingTests.join(" ")).toContain("rotates the token");
  });

  it("reads pytest failures", () => {
    const output = [
      "=================================== FAILURES ===================================",
      "FAILED tests/test_service.py::test_charge_customer - AssertionError: assert 0 == 1",
    ].join("\n");

    const outcome = parseTestOutput(output, 1);
    expect(outcome.failingFiles).toContain("tests/test_service.py");
    expect(outcome.failingTests).toContain("test_charge_customer");
  });

  it("reads jest bullet output", () => {
    const outcome = parseTestOutput("  ● Auth › refresh › rotates\n\n    expect(received)", 1);
    expect(outcome.failingTests.join(" ")).toContain("Auth > refresh > rotates");
  });

  it("strips ANSI colour before matching", () => {
    const outcome = parseTestOutput("[31m FAIL [0m src/a.test.ts", 1);
    expect(outcome.failingFiles).toContain("src/a.test.ts");
  });

  it("treats a clean zero-exit run as not failed", () => {
    expect(parseTestOutput(" ✓ src/a.test.ts (3 tests)\n", 0).failed).toBe(false);
  });

  it("falls back to the exit code for an unrecognised format", () => {
    expect(parseTestOutput("something went wrong", 1).failed).toBe(true);
    expect(parseTestOutput("something went wrong", 1).failingFiles).toEqual([]);
  });
});

describe("TDD state machine", () => {
  it("records a written test with no red observed yet", () => {
    recordTestWritten(repo.root, "src/a.test.ts");
    const status = redObservedFor(repo.root, "src/a.test.ts");
    expect(status.observed).toBe(false);
    expect(status.reason).toContain("not been seen failing");
  });

  it("observes red after a failing run", () => {
    recordTestWritten(repo.root, "src/a.test.ts", 1000);
    recordRedObserved(repo.root, ["src/a.test.ts"], ["adds"], 2000);
    expect(redObservedFor(repo.root, "src/a.test.ts").observed).toBe(true);
  });

  it("invalidates a red observed before the test was last edited", () => {
    recordTestWritten(repo.root, "src/a.test.ts", 1000);
    recordRedObserved(repo.root, ["src/a.test.ts"], [], 2000);
    // The developer edits the test again — the old red no longer proves anything.
    recordTestWritten(repo.root, "src/a.test.ts", 3000);

    const status = redObservedFor(repo.root, "src/a.test.ts");
    expect(status.observed).toBe(false);
    expect(status.reason).toContain("edited after the last failing run");
  });

  it("keeps state per branch", () => {
    recordTestWritten(repo.root, "src/a.test.ts", 1000);
    recordRedObserved(repo.root, ["src/a.test.ts"], [], 2000);
    expect(redObservedFor(repo.root, "src/a.test.ts").observed).toBe(true);

    repo.git(["checkout", "--quiet", "-b", "other-branch"]);
    expect(redObservedFor(repo.root, "src/a.test.ts").observed).toBe(false);
  });

  it("clears a branch's state", () => {
    recordTestWritten(repo.root, "src/a.test.ts");
    clearBranch(repo.root, currentBranch(repo.root));
    expect(Object.keys(readState(repo.root).branches)).not.toContain(currentBranch(repo.root));
  });

  it("survives a corrupt state file", () => {
    repo.write(".keel/tdd-state.json", "{ not json");
    expect(() => recordTestWritten(repo.root, "src/a.test.ts")).not.toThrow();
    expect(redObservedFor(repo.root, "src/a.test.ts").observed).toBe(false);
  });

  it("survives a torn journal line", () => {
    recordTestWritten(repo.root, "src/a.test.ts", 1000);
    recordRedObserved(repo.root, ["src/a.test.ts"], [], 2000);
    // A process killed mid-append leaves a partial record behind.
    appendFileSync(journalPath(repo.root), '{"kind":"written","branch":"ma');

    expect(redObservedFor(repo.root, "src/a.test.ts").observed).toBe(true);
    expect(() => recordTestWritten(repo.root, "src/b.test.ts")).not.toThrow();
  });
});

/**
 * Defect 5: hooks run once per tool call and tool calls run in parallel, so
 * several processes update the ledger at the same instant. The read-modify-write
 * this replaced kept 34 of 320 expectations under this exact load, and a RED
 * erased by a concurrent write makes gate 3 block work the developer earned.
 */
describe("concurrent writers", () => {
  const WRITERS = 8;
  const PER_WRITER = 40;

  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "keel-tdd-writer-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  /** A standalone process that records expectations through the real module. */
  async function buildWriter(): Promise<string> {
    const outfile = join(workspace, "writer.mjs");
    await build({
      stdin: {
        contents: [
          'import { recordTestWritten } from "./src/tdd/state.js";',
          "const [root, prefix, count] = process.argv.slice(2);",
          "for (let i = 0; i < Number(count); i++) {",
          "  recordTestWritten(root, `${prefix}-${i}.test.ts`, 1000 + i);",
          "}",
        ].join("\n"),
        resolveDir: PLUGIN_ROOT,
        sourcefile: "writer.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      outfile,
    });
    return outfile;
  }

  function runWriter(writer: string, index: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [writer, repo.root, `w${index}`, String(PER_WRITER)],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writer w${index} exited with ${String(code)}`));
      });
    });
  }

  it("loses no expectations when eight processes record at once", async () => {
    const writer = await buildWriter();

    // An observed RED, of the kind post-bash records, must survive the storm.
    recordTestWritten(repo.root, "src/money.test.ts", 1000);
    recordRedObserved(repo.root, ["src/money.test.ts"], ["converts"], 2000);

    await Promise.all(
      Array.from({ length: WRITERS }, (_unused, index) => runWriter(writer, index)),
    );

    const recorded = branchState(readState(repo.root), currentBranch(repo.root)).expectations;
    expect(Object.keys(recorded)).toHaveLength(WRITERS * PER_WRITER + 1);
    expect(redObservedFor(repo.root, "src/money.test.ts").observed).toBe(true);
  }, 60_000);

  it("folds a long journal into the snapshot without losing records", () => {
    const branch = currentBranch(repo.root);
    recordTestWritten(repo.root, "src/first.test.ts", 1000);

    // Past the compaction threshold, written directly so the test does not pay
    // for two thousand `git rev-parse` calls to get there.
    const bulk: string[] = [];
    for (let i = 0; i < 2000; i++) {
      bulk.push(
        JSON.stringify({ kind: "written", branch, files: [`src/bulk-${i}.test.ts`], at: 1000 + i }),
      );
    }
    appendFileSync(journalPath(repo.root), `${bulk.join("\n")}\n`);

    // The next ordinary update folds the journal into the snapshot.
    recordTestWritten(repo.root, "src/last.test.ts", 9000);

    expect(statSync(statePath(repo.root)).size).toBeGreaterThan(0);
    expect(existsSync(journalPath(repo.root))).toBe(false);
    const recorded = branchState(readState(repo.root), branch).expectations;
    expect(Object.keys(recorded)).toHaveLength(2002);
  });
});

describe("the full TDD flow a developer actually performs", () => {
  it("lets test-first work through, and blocks implementation-first", async () => {
    // 1. Implementation first, with no test: blocked.
    repo.write("src/money.ts", "export function toCents(amount: number): number {\n  return amount * 100;\n}\n");
    const first = await run("src/money.ts");
    expect(first.blocking).toBe(true);
    expect(first.outcomes[0]?.violations[0]?.message).toContain("toCents");

    // 2. Developer backs out and writes the test first.
    repo.git(["checkout", "--quiet", "--", "."]);
    repo.git(["clean", "-qfd"]);
    repo.write(
      "src/money.test.ts",
      ["import { toCents } from './money.js';", "it('converts to cents', () => { expect(toCents(2.5)).toBe(250); });"].join("\n"),
    );
    const testWrite = await run("src/money.test.ts");
    expect(testWrite.blocking).toBe(false);

    // 3. They run the tests and watch them fail.
    recordRedObserved(repo.root, ["src/money.test.ts"], ["converts to cents"]);

    // 4. Now the implementation goes through.
    repo.write("src/money.ts", "export function toCents(amount: number): number {\n  return Math.round(amount * 100);\n}\n");
    const implement = await run("src/money.ts");
    expect(implement.blocking).toBe(false);
  });

  it("does not ask twice about the same symbol", async () => {
    repo.write(
      "src/money.test.ts",
      "import { toCents } from './money.js';\nit('a', () => { expect(toCents(1)).toBe(100); });",
    );
    await run("src/money.test.ts");
    recordRedObserved(repo.root, ["src/money.test.ts"], ["a"]);

    repo.write("src/money.ts", "export function toCents(a: number): number {\n  return a * 100;\n}\n");
    expect((await run("src/money.ts")).blocking).toBe(false);

    // Editing the same symbol again must not re-trigger the gate.
    repo.write("src/money.ts", "export function toCents(a: number): number {\n  return Math.round(a * 100);\n}\n");
    expect((await run("src/money.ts")).blocking).toBe(false);
  });

  it("leaves changes to existing symbols alone", async () => {
    repo.writeCommitted("src/util.ts", "export function slug(s: string): string {\n  return s;\n}\n");
    repo.write("src/util.ts", "export function slug(s: string): string {\n  return s.toLowerCase();\n}\n");
    expect((await run("src/util.ts")).blocking).toBe(false);
  });

  it("ignores private symbols", async () => {
    repo.writeCommitted("src/util.ts", "export function slug(s: string): string {\n  return s;\n}\n");
    repo.write(
      "src/util.ts",
      "function helper(s: string): string { return s.trim(); }\nexport function slug(s: string): string {\n  return helper(s);\n}\n",
    );
    expect((await run("src/util.ts")).blocking).toBe(false);
  });
});

/**
 * Defect 1: `tests/money.test.js` beside `src/util/money.js` is what every JS
 * runner produces out of the box, and gate 3 used to answer "no test file
 * exists for this module" about a module that had one.
 */
describe("test layouts a JS project actually uses", () => {
  it("lets implementation through when the test lives in a flat tests/ directory", async () => {
    repo.write(
      "tests/money.test.js",
      [
        "import { toCents } from '../src/util/money.js';",
        "it('converts to cents', () => { expect(toCents(2.5)).toBe(250); });",
      ].join("\n"),
    );
    expect((await run("tests/money.test.js")).blocking).toBe(false);
    recordRedObserved(repo.root, ["tests/money.test.js"], ["converts to cents"]);

    repo.write(
      "src/util/money.js",
      "export function toCents(amount) {\n  return Math.round(amount * 100);\n}\n",
    );
    const implement = await run("src/util/money.js");
    expect(implement.outcomes.flatMap((o) => o.violations)).toEqual([]);
    expect(implement.blocking).toBe(false);
  });

  it("still blocks implementation when no test file exists anywhere", async () => {
    repo.write("src/util/money.js", "export function toCents(a) {\n  return a * 100;\n}\n");
    const result = await run("src/util/money.js");
    expect(result.blocking).toBe(true);
    expect(result.outcomes[0]?.violations[0]?.message).toContain("no test file exists");
  });
});

/**
 * Defect 6: "before is empty" and "we could not read before" are different
 * facts. Conflating them made every exported symbol look newly added, and the
 * hook blocked an edit to a committed, unmodified file.
 */
describe("git that cannot answer", () => {
  const ADDS_A_SYMBOL = [
    "export function slug(s) {",
    "  return s.toLowerCase();",
    "}",
    "export function titleCase(s) {",
    "  return s;",
    "}",
    "",
  ].join("\n");

  it("lets an edit through when git is unavailable", async () => {
    repo.writeCommitted("src/util.js", "export function slug(s) {\n  return s;\n}\n");
    repo.write("src/util.js", ADDS_A_SYMBOL);

    // With git working the same edit is a real block, so the assertion below
    // is about git being unreachable and nothing else.
    const withGit = await run("src/util.js");
    expect(withGit.blocking).toBe(true);
    expect(withGit.outcomes[0]?.violations[0]?.message).toContain("titleCase");

    const realPath = process.env["PATH"];
    try {
      process.env["PATH"] = join(repo.root, "no-such-bin");
      const withoutGit = await run("src/util.js");
      expect(withoutGit.skipped).toBe("indeterminate");
      expect(withoutGit.blocking).toBe(false);
    } finally {
      process.env["PATH"] = realPath;
    }
  });

  it("lets an edit to a gitignored file through", async () => {
    repo.writeCommitted(".gitignore", ".keel/\ngenerated/\n");
    const generated = "export function fetchUser(id) {\n  return id;\n}\n";

    repo.write("generated/api.js", generated);
    const ignored = await run("generated/api.js");
    expect(ignored.skipped).toBe("ignored");
    expect(ignored.blocking).toBe(false);

    // The identical file outside the ignored directory still blocks, so this
    // is the ignore rule letting it through rather than an inert gate.
    repo.write("src/api.js", generated);
    expect((await run("src/api.js")).blocking).toBe(true);
  });

  it("does not treat a committed, unmodified file as newly implemented", async () => {
    repo.writeCommitted("src/util.js", "export function slug(s) {\n  return s;\n}\n");
    const result = await run("src/util.js");
    expect(result.outcomes.flatMap((o) => o.violations)).toEqual([]);
    expect(result.blocking).toBe(false);
  });
});

/** Defect 2: the escape hatch reached gate 1 and silently skipped gate 4. */
describe("the assertion-lint escape hatch", () => {
  it("suppresses an assertion-lint block when a reason is given", async () => {
    repo.write("src/a.test.js", "it('does something', () => { add(1, 2); });\n");
    expect((await run("src/a.test.js")).blocking).toBe(true);

    repo.write(
      "src/a.test.js",
      [
        "// keel: allow-test-change smoke check while the API settles",
        "it('does something', () => { add(1, 2); });",
      ].join("\n"),
    );
    const allowed = await run("src/a.test.js");
    expect(allowed.blocking).toBe(false);
    expect(allowed.outcomes.some((o) => o.gate === "assertion-lint" && o.overridden)).toBe(true);
  });
});

describe("exemptions", () => {
  it("skips everything when tdd.enabled is false", async () => {
    repo.write("src/money.ts", "export function toCents(a: number): number { return a; }\n");
    const result = await runTddGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: { ...repo.config(), tdd: { ...repo.config().tdd, enabled: false } },
      filePath: "src/money.ts",
      sessionId: "s1",
    });
    expect(result.skipped).toBe("disabled");
    expect(result.blocking).toBe(false);
  });

  it("skips exempt globs", async () => {
    repo.write("db/migrations/0001.ts", "export function up(): void {}\n");
    const result = await run("db/migrations/0001.ts");
    expect(result.skipped).toBe("exempt");
  });

  it("skips unsupported file types", async () => {
    repo.write("docs/notes.md", "# notes\n");
    expect((await run("docs/notes.md")).skipped).toBe("unsupported");
  });

  it("relaxes gates 1 and 3 in spike mode but keeps 2 and 4", async () => {
    setSpike(repo.root, "spike-session", true);

    // Gate 3 relaxed: implementation with no red goes through.
    repo.write("src/money.ts", "export function toCents(a: number): number { return a * 100; }\n");
    const implementation = await run("src/money.ts", "spike-session");
    expect(implementation.spike).toBe(true);
    expect(implementation.blocking).toBe(false);

    // Gate 4 still fires: an assertion-free test is still an assertion-free test.
    repo.write("src/money.test.ts", "it('does something', () => { toCents(1); });\n");
    const testEdit = await run("src/money.test.ts", "spike-session");
    expect(testEdit.blocking).toBe(true);
    expect(testEdit.outcomes.some((o) => o.gate === "assertion-lint")).toBe(true);
  });
});

describe("M6 acceptance — zero false positives on this repo's own test suite", () => {
  function collectTestFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        collectTestFiles(abs, out);
      } else if (entry.endsWith(".test.ts")) {
        out.push(abs);
      }
    }
    return out;
  }

  it("flags nothing across every test file in this repository", async () => {
    const testFiles = collectTestFiles(join(PLUGIN_ROOT, "tests"));
    expect(testFiles.length).toBeGreaterThan(5);

    const offenders: string[] = [];

    for (const abs of testFiles) {
      const result = await runTddGates({
        repoRoot: PLUGIN_ROOT,
        pluginRoot: PLUGIN_ROOT,
        config: repo.config(),
        filePath: abs,
        sessionId: "acceptance",
      });

      for (const outcome of result.outcomes) {
        for (const violation of outcome.violations) {
          offenders.push(
            `${relative(PLUGIN_ROOT, abs)}:${violation.line ?? 0} [${violation.gate}] ${violation.message}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  }, 300_000);
});
