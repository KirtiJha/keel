import { spawnSync } from "node:child_process";

import { errorMessage, type Result, err, ok } from "./result.js";

export interface ExecOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExecOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Synchronous subprocess with a hard timeout.
 *
 * Sync on purpose: hooks are single-shot processes that exit as soon as they
 * answer, so there is no event loop to keep free, and sync keeps the control
 * flow (and therefore the failure modes) obvious.
 */
export function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Result<ExecOutput, string> {
  try {
    const res = spawnSync(command, [...args], {
      cwd: options.cwd ?? process.cwd(),
      input: options.input ?? undefined,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      env: options.env ?? process.env,
      windowsHide: true,
    });

    if (res.error) return err(`${command}: ${errorMessage(res.error)}`);
    if (res.signal !== null) return err(`${command}: killed by ${res.signal} (timeout?)`);

    return ok({
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      code: res.status ?? 0,
    });
  } catch (cause) {
    return err(`${command}: ${errorMessage(cause)}`);
  }
}

/** Resolve the Python interpreter to use for the Python gate runner. */
export function pythonBin(): string {
  return process.env["KEEL_PYTHON"] ?? "python3";
}
