import { proceed, runHook, targetFilePath, type HookDecision } from "../shared/hook-io.js";
import { routeSkills } from "../context/skill-router.js";

import { hookContext } from "./context.js";

/**
 * PreToolUse on Write|Edit: surface guide-mode standards for the target path.
 *
 * Suggest, never force (M4). This only ever attaches `additionalContext` — it
 * returns no permission decision, so it cannot block an edit. Guides that would
 * block belong in `gate` mode.
 *
 * Path matching only: no AST, no git. That keeps it comfortably inside the
 * 200 ms budget for hooks that never load the compiler.
 */
await runHook(
  "pre-tool-use",
  (input): HookDecision => {
    const filePath = targetFilePath(input);
    if (filePath === null) return proceed({ suppressOutput: true });

    const context = hookContext(input);
    const routed = routeSkills(
      context.repoRoot,
      context.pluginRoot,
      context.config,
      filePath,
      context.sessionId,
    );

    if (routed.additionalContext === null) return proceed({ suppressOutput: true });

    return proceed({
      suppressOutput: true,
      statusMessage: `loading ${routed.packs.length} standard${routed.packs.length === 1 ? "" : "s"}…`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: routed.additionalContext,
      },
    });
  },
  { budgetMs: 200 },
);
