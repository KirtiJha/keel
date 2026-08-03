import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { keelSubdir } from "./paths.js";
import { redact, redactValue } from "./redact.js";

/**
 * Debug log. Constraint 0.3: a crashed hook must never break a session, so
 * *every* function here swallows its own failures. A log that throws is worse
 * than no log.
 *
 * Constraint 0.6: no network. This writes to a local file and nothing else.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

let cachedRoot: string | null = null;

export function setLogRoot(root: string): void {
  cachedRoot = root;
}

function logFilePath(): string | null {
  if (cachedRoot === null) return null;
  try {
    const dir = keelSubdir(cachedRoot, "logs");
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    return join(dir, `keel-${day}.log`);
  } catch {
    return null;
  }
}

/** True when KEEL_DEBUG is set to anything other than "0"/"false"/"". */
export function debugEnabled(): boolean {
  const v = process.env["KEEL_DEBUG"];
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  try {
    if (level === "debug" && !debugEnabled()) return;
    const path = logFilePath();
    if (path === null) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redact(message),
      ...(data === undefined ? {} : { data: redactValue(data) }),
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Deliberately silent. See module comment.
  }
}

export const logDebug = (m: string, d?: Record<string, unknown>): void => log("debug", m, d);export const logWarn = (m: string, d?: Record<string, unknown>): void => log("warn", m, d);
export const logError = (m: string, d?: Record<string, unknown>): void => log("error", m, d);

/** Millisecond stopwatch used to record measured (never assumed) hook timings. */
export function stopwatch(): () => number {
  const started = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - started) / 1e6;
}
