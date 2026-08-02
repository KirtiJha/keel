import { bashCommand, proceed, runHook, type HookDecision, type HookInput } from "../shared/hook-io.js";
import { logDebug } from "../shared/log.js";
import { recordCheck } from "../display/state.js";
import { branchState, readState, recordRedObserved } from "../tdd/state.js";
import { currentBranch } from "../shared/git.js";
import { isTestCommand, parseTestOutput } from "../tdd/test-run.js";

import { hookContext } from "./context.js";

/**
 * PostToolUse on Bash: watch for test runs and record observed RED.
 *
 * This is what makes gate 3 invisible to a developer working normally. They
 * write a test, run it, see it fail — and that ordinary run is the evidence the
 * gate needs. There is no separate command to remember, because a step you have
 * to remember is a step an agent will skip.
 */

function toolOutput(input: HookInput): { text: string; code: number } {
  const response = input.tool_response;
  if (response === undefined) return { text: "", code: 0 };

  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "output", "content"]) {
    const value = response[key];
    if (typeof value === "string") parts.push(value);
  }

  const codeValue = response["exit_code"] ?? response["exitCode"] ?? response["code"];
  const code = typeof codeValue === "number" ? codeValue : parts.length > 0 ? 0 : 0;

  return { text: parts.join("\n"), code };
}

await runHook(
  "post-bash",
  (input): HookDecision => {
    const command = bashCommand(input);
    if (command === null || !isTestCommand(command)) {
      return proceed({ suppressOutput: true });
    }

    const context = hookContext(input);
    if (!context.config.tdd.enabled) return proceed({ suppressOutput: true });

    const { text, code } = toolOutput(input);
    const outcome = parseTestOutput(text, code);

    if (!outcome.failed) {
      recordCheck(context.repoRoot, null, { label: "tests", ok: true });
      return proceed({ suppressOutput: true, statusMessage: "tests green" });
    }

    // Prefer the files the runner actually named. When the format was not
    // recognised, fall back to every test file with an open expectation on this
    // branch — those are the ones the developer has been editing.
    let files: readonly string[] = outcome.failingFiles;
    if (files.length === 0) {
      const branch = branchState(readState(context.repoRoot), currentBranch(context.repoRoot));
      files = Object.keys(branch.expectations);
    }

    recordRedObserved(context.repoRoot, files, outcome.failingTests);
    recordCheck(context.repoRoot, null, {
      label: "tests",
      ok: false,
      ...(outcome.failingTests.length > 0
        ? { detail: `${outcome.failingTests.length} failing` }
        : {}),
    });

    logDebug("recorded observed red", {
      files: files.length,
      tests: outcome.failingTests.length,
    });

    return proceed({ suppressOutput: true, statusMessage: "red observed" });
  },
  { budgetMs: 200 },
);
