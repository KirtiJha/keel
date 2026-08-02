import { proceed, runHook, type HookDecision, type HookInput } from "../shared/hook-io.js";
import { formatMessage } from "../display/format.js";
import { readDisplayState } from "../display/state.js";

import { hookContext } from "./context.js";

/**
 * MessageDisplay: replace what is on screen with the four-row Keel format.
 *
 * Display-only — the transcript and the model's context keep the original — so
 * this is safe to iterate on aggressively. Budget is 100 ms against a platform
 * timeout of 10 s; returning nothing leaves the original text untouched.
 *
 * No matcher, so this fires on every message. It must stay cheap: one small
 * state read and pure string work, nothing else.
 */

function messageText(input: HookInput): string | null {
  const message = input.message;
  if (typeof message === "string") return message;

  if (typeof message === "object" && message !== null) {
    const record = message as Record<string, unknown>;

    const text = record["text"] ?? record["content"];
    if (typeof text === "string") return text;

    // Content blocks: concatenate the text ones.
    if (Array.isArray(text)) {
      const parts = text
        .map((block) =>
          typeof block === "object" && block !== null
            ? (block as Record<string, unknown>)["text"]
            : undefined,
        )
        .filter((t): t is string => typeof t === "string");
      return parts.length > 0 ? parts.join("\n") : null;
    }
  }

  return null;
}

await runHook(
  "message-display",
  (input): HookDecision => {
    const startedAt = process.hrtime.bigint();

    const text = messageText(input);
    if (text === null) return proceed({ suppressOutput: true });

    const context = hookContext(input);
    if (!context.config.display.enabled) return proceed({ suppressOutput: true });

    const formatted = formatMessage(text, readDisplayState(context.repoRoot), {
      budgetMs: context.config.display.budget_ms,
      startedAt,
    });

    // Null means "leave it alone" — never an error, never a blank screen.
    if (formatted === null) return proceed({ suppressOutput: true });

    return proceed({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "MessageDisplay",
        displayContent: formatted,
      },
    });
  },
  { budgetMs: 100 },
);
