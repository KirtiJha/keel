import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSpike } from "../../src/context/session-state.js";
import { runTddGates } from "../../src/tdd/index.js";
import {
  clearBranch,
  readState,
  recordRedObserved,
  recordTestWritten,
  redObservedFor,
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
