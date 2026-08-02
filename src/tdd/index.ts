import type { KeelConfig } from "../shared/config.js";
import { exec } from "../shared/exec.js";
import { changedLines, readWorkingFile, showFile } from "../shared/git.js";
import { matchesAny } from "../shared/glob.js";
import { logDebug, stopwatch } from "../shared/log.js";
import { toRepoRelative } from "../shared/paths.js";
import { isPythonFile, isTypeScriptLike } from "../shared/ast/ts.js";
import { isSpike } from "../context/session-state.js";
import { diffSymbols, symbolsOf } from "../router/symbols.js";

import { analyseTests } from "./analysis.js";
import {
  type GateOutcome,
  gateAssertionLint,
  gateMockUnderTest,
  gateObservedRed,
  gateTestWeakening,
} from "./gates.js";
import { existingTestFor, isTestFile } from "./pairing.js";
import { isImplemented, recordImplemented, recordTestWritten, redObservedFor } from "./state.js";
import { findOverrides } from "./vocabulary.js";

/**
 * Wire the four gates to a file edit.
 *
 * Exemptions are honoured here, once, for all four gates (M6): `tdd.enabled`,
 * `tdd.exempt_globs`, and `--spike`. A gate cannot accidentally ignore an
 * exemption because no gate is consulted until this function decides to.
 */

export interface TddRunOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly config: KeelConfig;
  readonly filePath: string;
  readonly sessionId: string;
  /** Override the working-tree contents (used when a hook already has them). */
  readonly source?: string;
}

export interface TddRunResult {
  readonly path: string;
  readonly outcomes: readonly GateOutcome[];
  readonly blocking: boolean;
  /**
   * Why no gate ran, or null when they did.
   *
   * `indeterminate` is git failing to answer at all; `ignored` is a file git
   * deliberately does not track. Both let the edit through.
   */
  readonly skipped: "disabled" | "exempt" | "unsupported" | "indeterminate" | "ignored" | null;
  readonly spike: boolean;
  readonly durationMs: number;
}

function languageOf(path: string): "typescript" | "python" | null {
  if (isPythonFile(path)) return "python";
  if (isTypeScriptLike(path)) return "typescript";
  return null;
}

/**
 * Is this path ignored by git?
 *
 * Only asked when git reported no changed lines, because that answer is
 * ambiguous on its own: a committed, unmodified file and a `.gitignore`d one
 * look identical from there, and only the second must switch the gates off.
 */
function isIgnored(root: string, repoRelPath: string): boolean {
  const res = exec("git", ["check-ignore", "-q", "--", repoRelPath], { cwd: root });
  return res.ok && res.value.code === 0;
}

export async function runTddGates(options: TddRunOptions): Promise<TddRunResult> {
  const timer = stopwatch();
  const path = toRepoRelative(options.repoRoot, options.filePath);
  const spike = isSpike(options.repoRoot, options.sessionId);

  const base = { path, spike, outcomes: [] as GateOutcome[], blocking: false };

  if (!options.config.tdd.enabled) {
    return { ...base, skipped: "disabled", durationMs: timer() };
  }
  if (matchesAny(path, options.config.tdd.exempt_globs)) {
    return { ...base, skipped: "exempt", durationMs: timer() };
  }

  const language = languageOf(path);
  if (language === null) {
    return { ...base, skipped: "unsupported", durationMs: timer() };
  }

  const after = options.source ?? readWorkingFile(options.repoRoot, path);
  if (after === null) {
    return { ...base, skipped: "unsupported", durationMs: timer() };
  }

  /**
   * What git can actually say about this path, established once, before any
   * gate runs.
   *
   * "before is empty" and "we could not read before" are different facts, and
   * conflating them is what made this hook block a committed, unedited file:
   * `git show HEAD:path` returns null when git is missing, when the directory
   * is not a repository *and* when the file is ignored, and an empty before
   * makes every exported symbol look newly added. A hook that blocks because
   * git is unavailable is a broken hook, so both cases now fail open.
   */
  const changed = changedLines(options.repoRoot, path);
  if (!changed.known) {
    logDebug("tdd gates skipped: git cannot describe this path", {
      path,
      reason: changed.reason,
    });
    return { ...base, skipped: "indeterminate", durationMs: timer() };
  }
  // An ignored file is not part of any change. Generated and codegen output is
  // the common case, and treating it as wholly new blocked every edit to it.
  if (changed.lines.size === 0 && isIgnored(options.repoRoot, path)) {
    return { ...base, skipped: "ignored", durationMs: timer() };
  }

  const outcomes: GateOutcome[] = [];

  if (isTestFile(path, options.config.tdd.test_globs)) {
    const beforeText = showFile(options.repoRoot, "HEAD", path);
    const overrides = findOverrides(after);

    const afterAnalysis = await analyseTests(options.pluginRoot, path, after);
    const beforeAnalysis = beforeText === null
      ? null
      : await analyseTests(options.pluginRoot, path, beforeText);

    // Gate 1 needs a baseline; a new test file has nothing to weaken.
    // Spike mode relaxes gates 1 and 3 only (M6).
    if (beforeAnalysis !== null && !spike) {
      outcomes.push(gateTestWeakening(beforeAnalysis, afterAnalysis, overrides, language));
    }

    outcomes.push(gateMockUnderTest(path, afterAnalysis));
    // Gate 4 gets the same escape hatch as gate 1 — it is one comment, in one
    // vocabulary, and a developer who wrote a reason has earned both.
    outcomes.push(gateAssertionLint(afterAnalysis, overrides));

    // Writing a test opens an expectation that a failing run must close.
    recordTestWritten(options.repoRoot, path);
  } else if (!spike && changed.lines.size > 0) {
    // Diff-only, exactly as the standards gates are: a symbol can only be
    // *newly implemented* on a line this change touched. Zero changed lines
    // means git sees nothing here to have implemented.
    const beforeText = showFile(options.repoRoot, "HEAD", path) ?? "";
    const beforeSymbols = beforeText === ""
      ? []
      : await symbolsOf(options.pluginRoot, path, beforeText);
    const afterSymbols = await symbolsOf(options.pluginRoot, path, after);

    const newSymbols = diffSymbols(beforeSymbols, afterSymbols)
      .filter((d) => d.change === "added")
      .map((d) => d.name)
      // A symbol already waved through on this branch never asks again.
      .filter((name) => !isImplemented(options.repoRoot, `${path}#${name}`));

    if (newSymbols.length > 0) {
      const testFile = existingTestFor(options.repoRoot, path);
      const status = testFile === null
        ? { observed: false, testFile: null, reason: "no test file exists for this module" }
        : redObservedFor(options.repoRoot, testFile);

      const outcome = gateObservedRed(newSymbols, status, path);
      outcomes.push(outcome);

      // Once satisfied, stop asking about these symbols for this branch.
      if (outcome.violations.length === 0) {
        for (const name of newSymbols) recordImplemented(options.repoRoot, `${path}#${name}`);
      }
    }
  }

  return {
    path,
    outcomes,
    blocking: outcomes.some((o) => o.violations.length > 0),
    skipped: null,
    spike,
    durationMs: timer(),
  };
}

export { formatViolations } from "./gates.js";
export type { GateName, GateOutcome, TddViolation } from "./gates.js";
