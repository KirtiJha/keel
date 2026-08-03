import { logDebug, logError, setLogRoot, stopwatch } from "./log.js";
import { redact } from "./redact.js";
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
 * Largest stdin payload we will hold on to. A real hook payload is a few KB;
 * anything past this is a bug or a hostile writer, not a tool call. Past the cap
 * we stop accumulating and throw away what we have, because turning ~512 MB of
 * buffer into a string is an `ERR_STRING_TOO_LONG` throw (V8's max string
 * length) and anything smaller is still an OOM risk. A hook that cannot read
 * its input has to proceed, so the degraded read is an empty payload.
 */
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

/**
 * Idle deadline, reset on every chunk. A total deadline cut off a slow but
 * progressing writer mid-payload; the partial read then parsed to `{}` and a
 * blocking gate quietly became a no-op.
 */
const STDIN_IDLE_MS = 3000;

/**
 * Absolute deadline regardless of progress, so a writer that drips one byte at
 * a time forever cannot hold a hook open. The platform's own per-hook timeout
 * in `hooks/hooks.json` is the outer bound; this is Keel giving up on its own.
 */
const STDIN_TOTAL_MS = 10_000;

/** Why a read did not get the whole payload. */
export type StdinTruncation =
  | "oversize"
  | "idle-timeout"
  | "total-timeout"
  | "decode-failed"
  | "read-error";

export interface StdinRead {
  readonly text: string;
  /** Null when the whole payload arrived; otherwise why it did not. */
  readonly truncated: StdinTruncation | null;
  /** Bytes seen on the wire, including any dropped past the cap. */
  readonly bytes: number;
}

/**
 * Read all of stdin, reporting whether the read was complete.
 *
 * Nothing in here may throw. `finish` runs inside `data`/`end`/`error`
 * listeners, and a throw from a stream listener is an *uncaughtException*, not
 * a promise rejection — `runHook`'s try/catch would never see it and Node would
 * exit 1 with a stack trace, which Claude Code reads as a non-blocking error.
 */
export async function readStdinDetailed(
  idleMs = STDIN_IDLE_MS,
  totalMs = STDIN_TOTAL_MS,
): Promise<StdinRead> {
  if (process.stdin.isTTY === true) return { text: "", truncated: null, bytes: 0 };

  return new Promise<StdinRead>((resolveStdin) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_STDIN_BYTES) {
        // Unusable: drop it all rather than spend memory (or throw) decoding it.
        chunks.length = 0;
        finish("oversize");
        return;
      }
      chunks.push(chunk);
      // Progress: push the idle deadline out. `refresh` keeps the unref'd state.
      idleTimer.refresh();
    };
    const onEnd = (): void => finish(null);
    const onError = (): void => finish("read-error");

    const release = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      // A stream with no "error" listener turns a late error into an
      // uncaughtException, so leave a swallowing one attached.
      process.stdin.on("error", () => undefined);
      try {
        // Stop the flow: on the oversize path the writer may still be going,
        // and nothing downstream is going to read it.
        process.stdin.pause();
      } catch {
        // Nothing to do; we already have all we are going to use.
      }
    };

    const finish = (why: StdinTruncation | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      release();

      let text = "";
      let outcome = why;
      if (why !== "oversize") {
        try {
          text = Buffer.concat(chunks).toString("utf8");
        } catch {
          // ERR_STRING_TOO_LONG and friends. Degrade, never throw.
          text = "";
          outcome = "decode-failed";
        }
      }
      chunks.length = 0;
      resolveStdin({ text, truncated: outcome, bytes });
    };

    const idleTimer = setTimeout(() => finish("idle-timeout"), idleMs);
    const totalTimer = setTimeout(() => finish("total-timeout"), totalMs);
    // Do not hold the event loop open on a timer alone.
    if (typeof idleTimer.unref === "function") idleTimer.unref();
    if (typeof totalTimer.unref === "function") totalTimer.unref();

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
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

/**
 * How long a queued stdout/stderr write gets to reach the kernel before we stop
 * waiting. Only reached if the reader has gone away; unref'd so it can never be
 * the thing keeping the process alive.
 */
const DRAIN_TIMEOUT_MS = 2000;

/** One emission per process: the first decision to reach the wire wins. */
let emitted = false;

/**
 * Write the hook's one and only output, then exit with `code`.
 *
 * `process.exit` discards whatever is still queued on an *async* stream, and
 * stdout/stderr are async whenever they are pipes — which is exactly how Claude
 * Code runs a hook. Measured on this runtime: writing 2 MB then `process.exit`
 * delivered 65536 bytes, so a long blocking reason reached Claude cut mid-word.
 * Exit from the write callback instead, once the bytes are really gone.
 */
function emitAndExit(stream: NodeJS.WriteStream, text: string, code: number): void {
  if (emitted) return;
  emitted = true;

  // Redaction belongs here, at the one place every hook's output leaves the
  // process, for the same reason the fail-open contract does: no individual
  // hook can then forget it.
  //
  // It was previously wired only into the debug log — so the one channel that
  // *does not* reach the model was protected, and the two that do were not. A
  // gate whose finding quotes the offending line is the obvious way to write a
  // "no hardcoded secrets" pack, and Keel's own assertion-lint gate quotes the
  // test name; both put the secret verbatim into the blocking reason fed back
  // to Claude.
  //
  // Safe on the JSON path because the replacement is a bare `[redacted]` — no
  // quotes, no backslashes — so a redacted payload is still valid JSON.
  const safe = redact(text);

  // Set up front so that even an exit through some other path uses the right
  // code. Constraint 0.4: 2 blocks, 0 proceeds, 1 is never ours.
  process.exitCode = code;

  let done = false;
  const exitNow = (): void => {
    if (done) return;
    done = true;
    process.exit(code);
  };

  // Backstop: a reader that never drains us must not become a hang.
  const guard = setTimeout(exitNow, DRAIN_TIMEOUT_MS);
  if (typeof guard.unref === "function") guard.unref();

  try {
    // EPIPE and friends: the reader is gone, so there is nothing left to flush.
    stream.on("error", exitNow);
    stream.write(safe, exitNow);
  } catch {
    exitNow();
  }
}

let guardInstalled = false;

/**
 * Last line of defence for constraint 0.3.
 *
 * `runHook`'s try/catch only sees rejections. A throw inside a stream listener,
 * or a rejection nobody awaited, is an uncaughtException — Node prints a stack
 * to stderr and exits 1, and Claude Code reads 1 as a non-blocking error, so
 * the hook is both noisy and useless. Catch those too and fail open on 0.
 */
function installFailOpenGuard(name: string): void {
  if (guardInstalled) return;
  guardInstalled = true;

  const failOpen = (cause: unknown): void => {
    try {
      logError(`${name}: uncaught failure, failing open`, { error: errorMessage(cause) });
    } catch {
      // Nothing left to do; still exit 0.
    }
    emitAndExit(process.stdout, JSON.stringify({ suppressOutput: true }), 0);
  };

  process.on("uncaughtException", failOpen);
  process.on("unhandledRejection", failOpen);
}

export interface RunHookOptions {
  /** Milliseconds after which we log a budget breach. Measured, not enforced. */
  readonly budgetMs?: number;
}

/**
 * Run a hook end to end. This module is the only place that exits the process,
 * and it does so only through `emitAndExit`.
 */
export async function runHook(
  name: string,
  handler: HookHandler,
  options: RunHookOptions = {},
): Promise<void> {
  installFailOpenGuard(name);
  const elapsed = stopwatch();
  let input: HookInput = {};

  // A best-effort root before stdin is even read, so a failure during the read
  // still lands in the debug log. Refined below once the payload's cwd is known.
  try {
    setLogRoot(repoRootOrCwd(process.cwd()));
  } catch {
    // Logging is best effort; never a reason to fail.
  }

  try {
    const stdin = await readStdinDetailed();
    input = parseHookInput(stdin.text);
    setLogRoot(hookRoot(input));

    if (stdin.truncated !== null) {
      // A partial read parses to `{}` and the hook proceeds on an empty payload,
      // so a gate silently becomes a no-op. That must at least be visible.
      logDebug(`${name}: stdin not read in full`, {
        reason: stdin.truncated,
        bytes: stdin.bytes,
      });
    }

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
      emitAndExit(process.stderr, `${decision.reason}\n`, 2);
      return;
    }

    const output: HookOutput = decision.output ?? { suppressOutput: true };
    emitAndExit(process.stdout, JSON.stringify(output), 0);
    return;
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
    emitAndExit(process.stdout, JSON.stringify({ suppressOutput: true }), 0);
  }
}
