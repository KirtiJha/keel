import { logDebug, logError, setLogRoot, stopwatch } from "./log.js";
import { repoRootOrCwd } from "./paths.js";
import { errorMessage } from "./result.js";

/**
 * The contract every Keel hook shares: read stdin, decide, emit, exit.
 *
 * Constraint 0.3 — "a crashed hook must never break a developer's session" —
 * is enforced here rather than in each hook, so no individual hook can forget.
 * A thrown error, a malformed payload, or a missing config all exit 0.
 *
 * Constraint 0.4 — exit codes: 2 blocks, 0 proceeds. `exit 1` is never used for
 * policy, because Claude Code treats 1 as a non-blocking error and the action
 * proceeds anyway, which would turn a gate into a no-op.
 */

export interface HookInput {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly tool_response?: Record<string, unknown>;
  readonly message?: unknown;
  readonly prompt?: string;
  readonly [key: string]: unknown;
}

export interface HookSpecificOutput {
  readonly hookEventName: string;
  readonly additionalContext?: string;
  readonly permissionDecision?: "allow" | "deny" | "ask";
  readonly permissionDecisionReason?: string;
  readonly displayContent?: string;
}

export interface HookOutput {
  readonly continue?: boolean;
  /**
   * Plan §"Quiet gates": stdout goes to the debug log, not the transcript.
   * Every Keel hook sets this — passes are silent.
   */
  readonly suppressOutput?: boolean;
  /** One-line spinner text instead of raw tool output. */
  readonly statusMessage?: string;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: HookSpecificOutput;
}

/** A hook either lets the action through or blocks it with a reason. */
export type HookDecision =
  | { readonly kind: "proceed"; readonly output?: HookOutput }
  | { readonly kind: "block"; readonly reason: string };

export const proceed = (output?: HookOutput): HookDecision =>
  output === undefined ? { kind: "proceed" } : { kind: "proceed", output };

export const block = (reason: string): HookDecision => ({ kind: "block", reason });

/**
 * Read all of stdin, with a timeout so a hook can never hang the session when
 * no payload arrives (for example when run by hand from a shell).
 */
export async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY === true) return "";

  return new Promise<string>((resolveStdin) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      resolveStdin(Buffer.concat(chunks).toString("utf8"));
    };

    const timer = setTimeout(finish, timeoutMs);
    // Do not hold the event loop open on the timer alone.
    if (typeof timer.unref === "function") timer.unref();

    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export function parseHookInput(raw: string): HookInput {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as HookInput;
    }
    return {};
  } catch {
    // Malformed stdin is a proceed, not a crash. See constraint 0.3.
    return {};
  }
}

/** Repo root for this hook invocation: the payload's cwd wins over ours. */
export function hookRoot(input: HookInput): string {
  return repoRootOrCwd(typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd());
}

/** Absolute path a Write/Edit tool call targets, or null for other tools. */
export function targetFilePath(input: HookInput): string | null {
  const ti = input.tool_input;
  if (ti === undefined) return null;
  const candidate = ti["file_path"] ?? ti["filePath"] ?? ti["path"] ?? ti["notebook_path"];
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

/** Shell command a Bash tool call ran, or null. */
export function bashCommand(input: HookInput): string | null {
  const ti = input.tool_input;
  if (ti === undefined) return null;
  const cmd = ti["command"];
  return typeof cmd === "string" && cmd !== "" ? cmd : null;
}

export type HookHandler = (input: HookInput) => Promise<HookDecision> | HookDecision;

export interface RunHookOptions {
  /** Milliseconds after which we log a budget breach. Measured, not enforced. */
  readonly budgetMs?: number;
}

/**
 * Run a hook end to end. This is the only place that calls `process.exit`.
 */
export async function runHook(
  name: string,
  handler: HookHandler,
  options: RunHookOptions = {},
): Promise<void> {
  const elapsed = stopwatch();
  let input: HookInput = {};

  try {
    input = parseHookInput(await readStdin());
    setLogRoot(hookRoot(input));

    if (typeof input.session_id === "string" && input.session_id !== "") {
      process.env["KEEL_SESSION_ID"] = input.session_id;
    }

    const decision = await handler(input);
    const ms = elapsed();

    const budget = options.budgetMs;
    if (budget !== undefined && ms > budget) {
      logDebug(`${name}: over budget`, { ms: Math.round(ms), budget });
    }

    if (decision.kind === "block") {
      // Exit 2: stderr is fed back to Claude as the blocking reason.
      process.stderr.write(`${decision.reason}\n`);
      process.exit(2);
    }

    const output: HookOutput = decision.output ?? { suppressOutput: true };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch (cause) {
    // Fail open. A bug in Keel must never stop someone working.
    try {
      setLogRoot(hookRoot(input));
      logError(`${name}: crashed, failing open`, {
        error: errorMessage(cause),
        ms: Math.round(elapsed()),
      });
    } catch {
      // Nothing left to do; still exit 0.
    }
    process.stdout.write(JSON.stringify({ suppressOutput: true }));
    process.exit(0);
  }
}
