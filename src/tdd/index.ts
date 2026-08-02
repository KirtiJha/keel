import type { KeelConfig } from "../shared/config.js";
import { readWorkingFile, showFile } from "../shared/git.js";
import { matchesAny } from "../shared/glob.js";
import { stopwatch } from "../shared/log.js";
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
  readonly skipped: "disabled" | "exempt" | "unsupported" | null;
  readonly spike: boolean;
  readonly durationMs: number;
}

function languageOf(path: string): "typescript" | "python" | null {
  if (isPythonFile(path)) return "python";
  if (isTypeScriptLike(path)) return "typescript";
  return null;
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

  const outcomes: GateOutcome[] = [];

  if (isTestFile(path, options.config.tdd.test_globs)) {
    const beforeText = showFile(options.repoRoot, "HEAD", path);

    const afterAnalysis = await analyseTests(options.pluginRoot, path, after);
    const beforeAnalysis = beforeText === null
      ? null
      : await analyseTests(options.pluginRoot, path, beforeText);

    // Gate 1 needs a baseline; a new test file has nothing to weaken.
    // Spike mode relaxes gates 1 and 3 only (M6).
    if (beforeAnalysis !== null && !spike) {
      outcomes.push(
        gateTestWeakening(beforeAnalysis, afterAnalysis, findOverrides(after), language),
      );
    }

    outcomes.push(gateMockUnderTest(path, afterAnalysis));
    outcomes.push(gateAssertionLint(afterAnalysis));

    // Writing a test opens an expectation that a failing run must close.
    recordTestWritten(options.repoRoot, path);
  } else if (!spike) {
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
