import { proceed, runHook, type HookDecision } from "../shared/hook-io.js";
import { resetDisplayState } from "../display/state.js";

import { hookContext } from "./context.js";

/**
 * SessionEnd: drop per-task display state.
 *
 * SessionEnd hooks share a 1.5 s budget across all of them, so this does the
 * minimum. TDD state deliberately survives: it is per *branch*, not per
 * session, and a developer who observes RED, closes their laptop and implements
 * tomorrow must not be asked to prove it again.
 */
await runHook(
  "session-end",
  (input): HookDecision => {
    resetDisplayState(hookContext(input).repoRoot);
    return proceed({ suppressOutput: true });
  },
  { budgetMs: 200 },
);
