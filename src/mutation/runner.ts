import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KeelConfig } from "../shared/config.js";
import { detectCommands } from "../context/commands.js";
import { exec } from "../shared/exec.js";
import { changedLines, diffSummary, readWorkingFile } from "../shared/git.js";
import { matchesAny } from "../shared/glob.js";
import { logDebug, stopwatch } from "../shared/log.js";
import { isPythonFile, isTypeScriptLike } from "../shared/ast/ts.js";

import { generateMutants } from "./generate.js";
import { type Mutant, applyMutant, selectMutants } from "./operators.js";

/**
 * The mutation runner.
 *
 * For each mutant: write the mutated file, run the repo's own test command,
 * restore the original. A mutant is *killed* if the tests fail, and *survived*
 * if they pass — a survivor means the changed line can be broken without any
 * test noticing.
 *
 * Three properties this is built around:
 *
 * 1. **Diff-only.** Mutants are confined to changed lines, like every other
 *    gate. Whole-file mutation on a legacy repo would never finish and would
 *    report a score nobody could act on.
 * 2. **Deterministic.** Same diff, same mutants, same score. A gate that varies
 *    run to run is a gate that gets switched off.
 * 3. **Restore always.** The original file is written back in a `finally`, and
 *    the runner verifies the restore. Leaving a mutated file behind would be
 *    far worse than any missed finding.
 *
 * CI only. This is minutes of work, not milliseconds — it has no business in a
 * hook.
 */

export type MutantOutcome = "killed" | "survived" | "error" | "skipped";

export interface MutantResult {
  readonly mutant: Mutant;
  readonly outcome: MutantOutcome;
  readonly durationMs: number;
}

export interface MutationReport {
  readonly results: readonly MutantResult[];
  readonly killed: number;
  readonly survived: number;
  readonly errored: number;
  readonly total: number;
  /** killed / (killed + survived). Errors are excluded, not counted as kills. */
  readonly score: number;
  readonly minScore: number;
  readonly passed: boolean;
  readonly testCommand: string;
  readonly durationMs: number;
  /** Set when there was nothing to mutate — not a failure. */
  readonly note?: string;
}

/** The command used to decide whether a mutant is killed. */
export function resolveTestCommand(root: string, config: KeelConfig): string | null {
  if (config.mutation.test_command !== "") return config.mutation.test_command;
  return detectCommands(root).test ?? null;
}

function runTests(root: string, command: string, timeoutMs: number): "pass" | "fail" | "error" {
  const res = exec("sh", ["-c", command], { cwd: root, timeoutMs });
  if (!res.ok) return "error";
  return res.value.code === 0 ? "pass" : "fail";
}

/** Source files worth mutating: not tests, not exempt, in a supported language. */
function isMutable(path: string, config: KeelConfig): boolean {
  if (!isTypeScriptLike(path) && !isPythonFile(path)) return false;
  if (matchesAny(path, config.tdd.test_globs)) return false;
  if (matchesAny(path, config.tdd.exempt_globs)) return false;
  return true;
}

export interface RunOptions {
  readonly root: string;
  readonly pluginRoot: string;
  readonly config: KeelConfig;
  /** Base ref for the diff. Null compares the working tree to HEAD. */
  readonly against?: string | null;
  /** Progress callback, so a long CI run is not silent. */
  readonly onProgress?: (done: number, total: number, result: MutantResult) => void;
}

export async function runMutation(options: RunOptions): Promise<MutationReport> {
  const total = stopwatch();
  const { root, config } = options;

  const empty = (note: string, testCommand: string): MutationReport => ({
    results: [],
    killed: 0,
    survived: 0,
    errored: 0,
    total: 0,
    score: 1,
    minScore: config.mutation.min_score,
    // Nothing to mutate is not a failure. A change that touches no logic —
    // docs, config, formatting — must not fail a mutation gate.
    passed: true,
    testCommand,
    durationMs: total(),
    note,
  });

  /** Same shape as `empty`, but this one does not pass. */
  const failed = (note: string, testCommand: string): MutationReport => ({
    ...empty(note, testCommand),
    score: 0,
    passed: false,
  });

  const unresolved: string[] = [];
  const command = resolveTestCommand(root, config);
  if (command === null) {
    // Not "nothing to mutate" — that is a docs or config change and passes
    // honestly. This is "the instrument is broken", and reporting score 1 for
    // it meant a repo whose test script got renamed would post a perfect
    // mutation score, forever, in the one job standing in for coverage.
    return failed(
      "no test command detected — set `mutation.test_command` in keel.config.yaml",
      "",
    );
  }

  // ---- collect mutants from changed lines only ----
  const summary = diffSummary(root, options.against ?? null);
  const candidates: Mutant[] = [];

  for (const file of summary.files) {
    if (file.status === "deleted") continue;
    if (!isMutable(file.path, config)) continue;

    const source = readWorkingFile(root, file.path);
    if (source === null) continue;

    // The file list comes from `--against`, so the line set must too. Reading
    // it against HEAD meant that on any CI checkout — where the tree is clean —
    // every file yielded an empty set, no mutants were generated, and the gate
    // reported a perfect score without testing anything.
    const lines = changedLines(root, file.path, options.against ?? null);
    if (!lines.known) {
      unresolved.push(`${file.path}: ${lines.reason}`);
      continue;
    }

    candidates.push(
      ...(await generateMutants(file.path, source, {
        changedLines: lines.lines,
        pluginRoot: options.pluginRoot,
      })),
    );
  }

  if (candidates.length === 0) {
    // "Nothing to mutate" and "we could not work out what changed" are
    // different answers, and only the first one is a pass.
    if (unresolved.length > 0) {
      return failed(
        `could not determine changed lines for ${unresolved.length} file(s): ${unresolved.slice(0, 3).join("; ")}`,
        command,
      );
    }
    return empty("no mutable changed lines in this diff", command);
  }

  const selected = selectMutants(candidates, config.mutation.max_mutants);
  logDebug("mutation: selected mutants", {
    candidates: candidates.length,
    selected: selected.length,
  });

  // ---- baseline: the suite must be green before any mutant means anything ----
  const baseline = runTests(root, command, config.mutation.timeout_ms);
  if (baseline !== "pass") {
    return {
      ...empty("", command),
      passed: false,
      note:
        baseline === "error"
          ? `the test command did not run: \`${command}\``
          : "the test suite is already failing — fix it before mutation testing means anything",
    };
  }

  // ---- run ----
  const results: MutantResult[] = [];
  const originals = new Map<string, string>();

  try {
    for (const mutant of selected) {
      const abs = join(root, mutant.file);
      const timer = stopwatch();

      let original = originals.get(mutant.file);
      if (original === undefined) {
        try {
          original = readFileSync(abs, "utf8");
          originals.set(mutant.file, original);
        } catch {
          results.push({ mutant, outcome: "error", durationMs: timer() });
          continue;
        }
      }

      let outcome: MutantOutcome;
      try {
        writeFileSync(abs, applyMutant(original, mutant), "utf8");
        const run = runTests(root, command, config.mutation.timeout_ms);
        // Tests failing means the mutant was caught. That is the good case.
        outcome = run === "pass" ? "survived" : run === "fail" ? "killed" : "error";
      } catch {
        outcome = "error";
      } finally {
        // Restore immediately, not at the end: a crash mid-run must not leave
        // a mutated file on disk.
        try {
          writeFileSync(abs, original, "utf8");
        } catch {
          logDebug("mutation: could not restore file", { file: mutant.file });
        }
      }

      const result: MutantResult = { mutant, outcome, durationMs: timer() };
      results.push(result);
      options.onProgress?.(results.length, selected.length, result);
    }
  } finally {
    // Belt and braces: verify every touched file is byte-identical again.
    for (const [file, original] of originals) {
      const abs = join(root, file);
      try {
        if (readFileSync(abs, "utf8") !== original) writeFileSync(abs, original, "utf8");
      } catch {
        logDebug("mutation: restore verification failed", { file });
      }
    }
  }

  const killed = results.filter((r) => r.outcome === "killed").length;
  const survived = results.filter((r) => r.outcome === "survived").length;
  const errored = results.filter((r) => r.outcome === "error").length;
  const scored = killed + survived;
  const score = scored === 0 ? 1 : killed / scored;

  // Errors leave the denominator, which is right — an unapplied mutant proves
  // nothing either way — but it means a run where most mutants errored can post
  // a flattering score off the handful that survived. That is not a measurement,
  // so past a threshold the run reports no confidence rather than a pass.
  const errorShare = results.length === 0 ? 0 : errored / results.length;
  const tooManyErrors = errorShare > 0.5;

  const notes: string[] = [];
  if (errored > 0) {
    notes.push(`${errored} of ${results.length} mutants errored and are excluded from the score`);
  }
  if (tooManyErrors) {
    notes.push("more than half errored — treat this run as inconclusive, not as a pass");
  }

  return {
    results,
    killed,
    survived,
    errored,
    total: results.length,
    score,
    minScore: config.mutation.min_score,
    passed: !tooManyErrors && score >= config.mutation.min_score,
    testCommand: command,
    durationMs: total(),
    ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
  };
}
