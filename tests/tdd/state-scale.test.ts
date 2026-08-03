import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentBranch } from "../../src/shared/git.js";
import { runTddGates } from "../../src/tdd/index.js";
import {
  COMPACT_BYTES,
  MAX_BRANCHES,
  MAX_EXPECTATIONS,
  branchState,
  journalPath,
  readState,
  recordRedObserved,
  recordTestWritten,
  redObservedFor,
  statePath,
} from "../../src/tdd/state.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * The ledger sits on the PostToolUse hot path and several hook processes touch
 * it at the same instant. Two properties are load-bearing, and neither shows up
 * in a functional test: reading it must stay linear in the number of records,
 * and folding it must not lose records when two processes fold at once.
 *
 * Both regressed together. `readState` folded the journal by deep-copying the
 * whole expectations map per record — quadratic — and the hook read it once per
 * new exported symbol on top of that, which took a 20-symbol edit over a 120 KB
 * journal to 40 s against a 30 s platform timeout, so the gate reached no
 * verdict at all. Compaction read the snapshot, folded and wrote it back with
 * nothing protecting the sequence, so two overlapping compactions each dropped
 * the other's records — after the journal they came from had been deleted.
 */

// Mirrors of the module's own policy constants, so the setup arithmetic below
// does not silently follow a change to them. The first test pins the pair.
const THRESHOLD_BYTES = 128 * 1024;
const RETAINED_EXPECTATIONS = 5000;
const RETAINED_BRANCHES = 20;

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-tdd-scale-");
});

afterEach(() => {
  repo.dispose();
});

/** Write `count` `written` records straight into the journal, cheaply. */
function bulkJournal(root: string, branch: string, count: number, prefix = "bulk"): number {
  mkdirSync(join(root, ".keel"), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({ kind: "written", branch, files: [`src/${prefix}-${i}.test.ts`], at: 1000 + i }),
    );
  }
  const text = `${lines.join("\n")}\n`;
  appendFileSync(journalPath(root), text, "utf8");
  return Buffer.byteLength(text);
}

/** Grow the journal to roughly `targetBytes`, in small enough steps to land there. */
function fillJournalTo(root: string, branch: string, targetBytes: number): number {
  let bytes = 0;
  let round = 0;
  while (bytes < targetBytes) {
    bytes += bulkJournal(root, branch, 50, `filler${round}`);
    round++;
  }
  return bytes;
}

/** Enough journal to cross the threshold, then one ordinary update to fold it. */
function forceCompaction(root: string, branch: string): void {
  fillJournalTo(root, branch, THRESHOLD_BYTES);
  recordTestWritten(root, "src/trigger.test.ts", 9_000_000);
}

function millis(work: () => void): number {
  const started = process.hrtime.bigint();
  work();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("the ledger's retention policy", () => {
  it("is stated in constants a caller can read", () => {
    expect(COMPACT_BYTES).toBe(THRESHOLD_BYTES);
    expect(MAX_EXPECTATIONS).toBe(RETAINED_EXPECTATIONS);
    expect(MAX_BRANCHES).toBe(RETAINED_BRANCHES);
  });
});

describe("reading the ledger stays cheap enough for a hook", () => {
  /**
   * The fold used to allocate a fresh copy of every expectation seen so far for
   * each record it applied, so 4x the records cost ~16x the time. Linear work
   * costs ~4x. The ratio is what tells them apart, and the margin is wide enough
   * that a loaded machine cannot turn a linear fold into a failure.
   */
  it("folds a journal in time proportional to its length", () => {
    const branch = currentBranch(repo.root);
    bulkJournal(repo.root, branch, 2000);
    const small = millis(() => {
      readState(repo.root);
    });

    bulkJournal(repo.root, branch, 6000, "more");
    const large = millis(() => {
      readState(repo.root);
    });

    expect(Object.keys(branchState(readState(repo.root), branch).expectations)).toHaveLength(8000);
    expect(large / Math.max(small, 0.5)).toBeLessThan(8);
  }, 120_000);

  it("folds eight thousand records well inside the hook's budget", () => {
    const branch = currentBranch(repo.root);
    bulkJournal(repo.root, branch, 8000);

    const ms = millis(() => {
      readState(repo.root);
    });
    expect(ms).toBeLessThan(300);
  }, 120_000);

  /**
   * The other half: the hook read the whole ledger once per new exported symbol
   * and once more for the RED lookup. Twenty new exports over a populated ledger
   * measured 40 s against a 600 ms budget and a 30 s platform timeout, so Claude
   * Code killed the hook and the edit appeared to hang.
   */
  it("runs the gates over a populated ledger inside the hook's timeout", async () => {
    const branch = currentBranch(repo.root);

    repo.writeCommitted(
      "src/util.ts",
      "export function base(s: string): string {\n  return s;\n}\n",
    );
    repo.write(
      "src/util.test.ts",
      [
        "import { base } from './util.js';",
        "it('keeps the string', () => { expect(base('a')).toBe('a'); });",
      ].join("\n"),
    );

    // A snapshot carrying 800 expectations, and a journal just under the
    // threshold so the run pays the fold without also paying a compaction.
    const expectations: Record<string, unknown> = {};
    for (let i = 0; i < 800; i++) {
      expectations[`src/snap-${i}.test.ts`] = {
        writtenAt: 1000,
        redObservedAt: 2000,
        failingTests: [],
      };
    }
    mkdirSync(join(repo.root, ".keel"), { recursive: true });
    writeFileSync(
      statePath(repo.root),
      `${JSON.stringify({ version: 1, branches: { [branch]: { expectations, implemented: [] } } })}\n`,
      "utf8",
    );
    // 120 KB of journal: below the threshold, so this run folds it rather than
    // compacting it away — which is the state a working session actually sits in.
    fillJournalTo(repo.root, branch, 120 * 1024);

    // The developer has seen the test fail, so gate 3 has its evidence and the
    // run exercises the record-implemented path too.
    recordRedObserved(repo.root, ["src/util.test.ts"], ["keeps the string"], 3_000_000);

    const lines = ["export function base(s: string): string {", "  return s;", "}"];
    for (let i = 0; i < 20; i++) {
      lines.push(`export function added${i}(s: string): string {`, `  return s + "${i}";`, "}");
    }
    repo.write("src/util.ts", `${lines.join("\n")}\n`);

    const started = process.hrtime.bigint();
    const result = await runTddGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/util.ts",
      sessionId: "scale",
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    // The gate reached a verdict rather than being skipped, and reached it fast.
    expect(result.skipped).toBe(null);
    expect(result.blocking).toBe(false);
    expect(ms).toBeLessThan(3000);
  }, 120_000);
});

/**
 * Compaction is the only step that rewrites the snapshot, and it used to do so
 * with a plain read-fold-write. Two overlapping compactions clobbered each
 * other, and the loser's journal had already been deleted, so the records were
 * gone. Eight writers past the threshold reproduce it with no instrumentation
 * at all: 3200 records in, 2292 out.
 */
describe("compaction under concurrency", () => {
  const WRITERS = 8;
  const PER_WRITER = 400;
  /**
   * Long paths, so each record is large enough that the journal re-crosses the
   * threshold while an earlier compaction is still folding. That overlap is the
   * whole defect; short records simply hide it behind the compaction interval.
   */
  const PATH_PADDING = 500;

  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "keel-tdd-compact-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  async function buildWriter(): Promise<string> {
    const outfile = join(workspace, "writer.mjs");
    await build({
      stdin: {
        contents: [
          'import { recordTestWritten } from "./src/tdd/state.js";',
          "const [root, prefix, count, pad] = process.argv.slice(2);",
          'const filler = "x".repeat(Number(pad));',
          "for (let i = 0; i < Number(count); i++) {",
          "  recordTestWritten(root, `src/${filler}${prefix}-${i}.test.ts`, 1000 + i);",
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
        [writer, repo.root, `c${index}`, String(PER_WRITER), String(PATH_PADDING)],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writer c${index} exited with ${String(code)}`));
      });
    });
  }

  it("loses no records when eight processes drive it past the threshold", async () => {
    const writer = await buildWriter();
    const branch = currentBranch(repo.root);

    // The RED a developer already earned has to survive the storm too.
    recordTestWritten(repo.root, "src/money.test.ts", 1000);
    recordRedObserved(repo.root, ["src/money.test.ts"], ["converts"], 2000);

    await Promise.all(
      Array.from({ length: WRITERS }, (_unused, index) => runWriter(writer, index)),
    );

    const recorded = branchState(readState(repo.root), branch).expectations;
    expect(Object.keys(recorded)).toHaveLength(WRITERS * PER_WRITER + 1);
    expect(redObservedFor(repo.root, "src/money.test.ts").observed).toBe(true);
  }, 300_000);

  /**
   * A snapshot that could not be written must leave the journal it came from in
   * place. Writing the snapshot and deleting that journal in the wrong order
   * turns one failed write into permanent data loss.
   */
  it("keeps every record when the snapshot cannot be written", () => {
    const branch = currentBranch(repo.root);
    recordTestWritten(repo.root, "src/keeper.test.ts", 1000);
    recordRedObserved(repo.root, ["src/keeper.test.ts"], ["earned"], 2000);

    // A directory where the snapshot belongs: the temp file writes fine and the
    // rename onto it fails, which is the shape of a full or read-only disk
    // without needing either.
    rmSync(statePath(repo.root), { force: true });
    mkdirSync(statePath(repo.root), { recursive: true });

    fillJournalTo(repo.root, branch, THRESHOLD_BYTES);
    expect(() => {
      recordTestWritten(repo.root, "src/after.test.ts", 9_000_000);
    }).not.toThrow();

    // And again, because the second attempt is where an unfinished compaction
    // gets overwritten: rotating a fresh journal on top of one whose records
    // never reached the snapshot loses them without anything reporting a
    // failure.
    fillJournalTo(repo.root, branch, THRESHOLD_BYTES);
    expect(() => {
      recordTestWritten(repo.root, "src/later.test.ts", 9_100_000);
    }).not.toThrow();

    const recorded = branchState(readState(repo.root), branch).expectations;
    expect(recorded["src/keeper.test.ts"]).not.toBe(undefined);
    expect(recorded["src/after.test.ts"]).not.toBe(undefined);
    expect(recorded["src/later.test.ts"]).not.toBe(undefined);
    expect(redObservedFor(repo.root, "src/keeper.test.ts").observed).toBe(true);
  }, 120_000);
});

/**
 * Nothing pruned the ledger in production: the only two functions that could
 * have — `writeState` and `clearBranch` — have no production caller, and both
 * doc comments pointed at a `keel doctor --reset-tdd` flag that does not exist.
 * So it grew without bound, which is what fed the read cost above. Compaction
 * is the one step that rewrites the snapshot, so it is where the bound belongs.
 */
describe("the ledger is self-limiting", () => {
  it("drops a branch that no longer exists in git", () => {
    const main = currentBranch(repo.root);

    repo.git(["checkout", "--quiet", "-b", "gone"]);
    recordTestWritten(repo.root, "src/gone.test.ts", 5000);
    repo.git(["checkout", "--quiet", main]);
    repo.git(["branch", "-D", "gone"]);

    forceCompaction(repo.root, main);

    const branches = Object.keys(readState(repo.root).branches);
    expect(branches).not.toContain("gone");
    expect(branches).toContain(main);
  }, 120_000);

  it("bounds how many test files it retains", () => {
    const branch = currentBranch(repo.root);
    bulkJournal(repo.root, branch, RETAINED_EXPECTATIONS + 500);
    recordTestWritten(repo.root, "src/newest.test.ts", 9_000_000);

    const kept = branchState(readState(repo.root), branch).expectations;
    expect(Object.keys(kept).length).toBeLessThanOrEqual(RETAINED_EXPECTATIONS);
    // The bound drops the oldest, never the most recent — the recent ones are
    // the open expectations a developer is working through right now.
    expect(kept["src/newest.test.ts"]).not.toBe(undefined);
    expect(kept["src/bulk-0.test.ts"]).toBe(undefined);
  }, 120_000);

  it("bounds how many branches it retains", () => {
    const main = currentBranch(repo.root);
    const extra = RETAINED_BRANCHES + 5;
    mkdirSync(join(repo.root, ".keel"), { recursive: true });

    for (let i = 0; i < extra; i++) {
      const name = `topic-${i}`;
      repo.git(["branch", name]);
      // Recorded oldest-first, so the low-numbered branches are the stale ones.
      appendFileSync(
        journalPath(repo.root),
        `${JSON.stringify({ kind: "written", branch: name, files: [`src/${name}.test.ts`], at: 2000 + i })}\n`,
        "utf8",
      );
    }

    forceCompaction(repo.root, main);

    const branches = Object.keys(readState(repo.root).branches);
    expect(branches.length).toBeLessThanOrEqual(RETAINED_BRANCHES);
    expect(branches).toContain(main);
    expect(branches).toContain(`topic-${extra - 1}`);
    expect(branches).not.toContain("topic-0");
  }, 120_000);

  it("keeps the records it folds when it compacts normally", () => {
    const branch = currentBranch(repo.root);
    recordTestWritten(repo.root, "src/a.test.ts", 1000);

    forceCompaction(repo.root, branch);
    // Compaction ran: the snapshot exists and the journal was folded away.
    expect(existsSync(statePath(repo.root))).toBe(true);
    expect(existsSync(journalPath(repo.root))).toBe(false);

    const recorded = branchState(readState(repo.root), branch).expectations;
    expect(recorded["src/a.test.ts"]).not.toBe(undefined);
    expect(recorded["src/trigger.test.ts"]).not.toBe(undefined);
  }, 120_000);
});
