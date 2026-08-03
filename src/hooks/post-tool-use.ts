import { block, proceed, runHook, targetFilePath, type HookDecision } from "../shared/hook-io.js";
import { logDebug, stopwatch } from "../shared/log.js";
import { toRepoRelative } from "../shared/paths.js";
import { formatBlocking, runGates } from "../standards/runner.js";
import { formatViolations, runTddGates } from "../tdd/index.js";
import { recordCheck } from "../display/state.js";

import { emit, hookContext } from "./context.js";

/**
 * PostToolUse on Write|Edit: standards gates, then TDD gates.
 *
 * Quiet gates (plan §"Terminal output"): passes set `suppressOutput` and say
 * nothing. Only a failure prints, and it prints file, line, rule and fix.
 *
 * Exit 2 on a blocking finding; exit 0 on everything else including our own
 * crashes — see the fail-open contract in `runHook`.
 */
await runHook(
  "post-tool-use",
  async (input): Promise<HookDecision> => {
    const filePath = targetFilePath(input);
    if (filePath === null) return proceed({ suppressOutput: true });

    const context = hookContext(input);
    const total = stopwatch();
    const relPath = toRepoRelative(context.repoRoot, filePath);

    // ---- standards gates ----
    const gates = await runGates({
      repoRoot: context.repoRoot,
      pluginRoot: context.pluginRoot,
      config: context.config,
      filePath,
    });

    for (const result of gates.results) {
      emit(context, {
        kind: "gate",
        pack: result.pack,
        severity: result.severity,
        // A pack that did not run must not be recorded as one that passed.
        result: result.status === "untrusted" || result.status === "skipped"
          ? result.status
          : result.error !== undefined
            ? "error"
            : result.findings.length === 0
              ? "pass"
              : result.severity === "high"
                ? "fail"
                : "warn",
        finding_count: result.findings.length,
        duration_ms: result.durationMs,
      });
    }

    if (gates.blocking.length > 0) {
      recordCheck(context.repoRoot, relPath, {
        label: "standards",
        ok: false,
        detail: `${gates.blocking.length} finding${gates.blocking.length === 1 ? "" : "s"}`,
      });
      return block(formatBlocking(gates));
    }

    // ---- TDD gates ----
    const tdd = await runTddGates({
      repoRoot: context.repoRoot,
      pluginRoot: context.pluginRoot,
      config: context.config,
      filePath,
      sessionId: context.sessionId,
    });

    for (const outcome of tdd.outcomes) {
      emit(context, {
        kind: "tdd_gate",
        gate: outcome.gate,
        result: outcome.violations.length > 0 ? "block" : "pass",
        overridden: outcome.overridden,
        duration_ms: tdd.durationMs,
      });
    }

    if (tdd.blocking) {
      recordCheck(context.repoRoot, relPath, { label: "tdd", ok: false });
      return block(formatViolations(tdd.outcomes, tdd.path));
    }

    // ---- everything passed: say nothing ----
    //
    // "The gates passed" and "the gates did not run" used to be the same green
    // tick, because this only counted results. A pack whose rule threw, whose
    // compiled artifact was corrupt, or which is not approved to run produces a
    // result too — so a dead gate reported success. `health.complete` is false
    // whenever an applicable pack reached no verdict, and `health.detail` says
    // which.
    const checkedStandards = gates.results.length > 0;
    const checkedTdd = tdd.skipped === null && tdd.outcomes.length > 0;
    if (checkedStandards) {
      recordCheck(context.repoRoot, relPath, {
        label: "standards",
        ok: gates.health.complete,
        ...(gates.health.detail === "" ? {} : { detail: gates.health.detail }),
      });
    }
    if (checkedTdd) recordCheck(context.repoRoot, relPath, { label: "tdd", ok: true });
    if (!checkedStandards && !checkedTdd) recordCheck(context.repoRoot, relPath, null);

    const ms = total();
    // Only spool a timing when something was actually checked. Most edits in a
    // session match no pack and no gate, and recording those would both dwarf
    // the useful signal and add a file write to the hook's own hot path.
    if (checkedStandards || checkedTdd) {
      emit(context, {
        kind: "hook_timing",
        hook: "post-tool-use",
        duration_ms: ms,
        loaded_ast: checkedStandards,
      });
    }
    logDebug("post-tool-use complete", { ms: Math.round(ms), path: relPath });

    if (gates.advisory.length > 0) {
      // Advisory findings inform without blocking and without noise.
      return proceed({
        suppressOutput: true,
        statusMessage: `${gates.advisory.length} advisory standards finding${gates.advisory.length === 1 ? "" : "s"}`,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: formatBlocking({ ...gates, blocking: gates.advisory }),
        },
      });
    }

    // "checks passed" is a claim, and it was being made for three different
    // outcomes: the gates ran clean, a rule crashed, and a repo-local rule was
    // never approved to run. A pack author iterating inside Claude Code saw
    // those two identical words on every save and had no way to tell their rule
    // was dead. Nothing blocks here either way — the edit proceeds — but the
    // status line says which of the three actually happened.
    return proceed({
      suppressOutput: true,
      statusMessage: gates.health.complete
        ? "checks passed"
        : `checks incomplete — ${gates.health.detail || "a gate did not run"}`,
    });
  },
  { budgetMs: 600 },
);
