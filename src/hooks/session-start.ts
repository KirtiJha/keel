import { proceed, runHook, type HookDecision } from "../shared/hook-io.js";
import { isGitRepo } from "../shared/git.js";
import { resetDisplayState } from "../display/state.js";
import { loadPacks } from "../standards/loader.js";

import { hookContext } from "./context.js";

/**
 * SessionStart: clear per-task display state and tell the session what is active.
 *
 * Budget is 300 ms, so this does path work and a pack load — no AST, no diff,
 * no caller counting. Anything heavier belongs in `keel doctor`, which a human
 * runs deliberately.
 */
await runHook(
  "session-start",
  async (input): Promise<HookDecision> => {
    const context = hookContext(input);

    // Rows from a previous task must never bleed into this one.
    resetDisplayState(context.repoRoot);

    if (!isGitRepo(context.repoRoot) || !context.configPresent) {
      return proceed({ suppressOutput: true });
    }

    // An invalid config is the one thing worth interrupting for: every hook is
    // running on coerced defaults until it is fixed, and silence would hide it.
    //
    // The strict validator is imported *here*, lazily, so its ~26 ms of zod
    // module init is paid once per session rather than on every tool call.
    const { formatIssues, loadConfigStrict } = await import("../shared/config-schema.js");
    const loaded = loadConfigStrict(context.repoRoot);
    if (!loaded.ok) {
      return proceed({
        suppressOutput: true,
        systemMessage: `Keel: keel.config.yaml is invalid, so coerced defaults are in use.\n${formatIssues(loaded.error)}`,
      });
    }

    const { packs, overrides } = loadPacks(context.repoRoot, context.pluginRoot, context.config);
    const gates = packs.filter((p) => p.standard.mode === "gate").length;
    const guides = packs.filter((p) => p.standard.mode === "guide").length;

    const lines = [
      `Keel active: ${gates} gate${gates === 1 ? "" : "s"}, ${guides} guide${guides === 1 ? "" : "s"}.`,
      context.config.tdd.enabled
        ? "TDD gates on: write the test first and let it fail before implementing."
        : "TDD gates off.",
      "Track is chosen per change; run `keel route` to see it.",
    ];
    for (const override of overrides) {
      lines.push(`Repo-local pack \`${override.name}\` overrides the org version.`);
    }

    return proceed({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n"),
      },
    });
  },
  { budgetMs: 300 },
);
