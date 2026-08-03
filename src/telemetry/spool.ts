import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TELEMETRY_PATH, type KeelConfig } from "../shared/config.js";
import { logDebug, logWarn } from "../shared/log.js";
import { resolveConfiguredPath } from "../shared/paths.js";

import {
  parseEvent,
  repoId,
  serialiseEvent,
  type TelemetryEvent,
  type TelemetryEventInput,
} from "./events.js";

/**
 * Local JSONL spool.
 *
 * Constraint 0.6: no network calls inside hooks, ever. Recording is an
 * append to a local file; shipping is a separate, explicitly invoked command
 * (`keel telemetry ship`).
 */

export const PLUGIN_VERSION = "0.1.0";

/** One id per process. Hooks are single-shot, so this is per hook invocation. */
let sessionId: string | null = null;

function currentSession(): string {
  // Claude Code passes a session id on hook stdin; prefer it so all hooks in
  // one session agree, and fall back to a random id for CLI invocations.
  const fromEnv = process.env["KEEL_SESSION_ID"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  sessionId ??= randomUUID();
  return sessionId;
}

/**
 * Where the spool lives.
 *
 * `telemetry.path` is documented as "a repo-relative directory", and that is
 * enforced here rather than assumed: `resolve` alone honoured both
 * `../../../../tmp/evil` and `/tmp/evil`, creating directories and writing
 * `events-*.jsonl` outside the working tree. An escaping value is logged once
 * and replaced with the default — telemetry keeps recording, in the right place.
 */
export function spoolDir(root: string, config: KeelConfig): string {
  const resolved = resolveConfiguredPath(root, config.telemetry.path, {
    key: "telemetry.path",
    fallback: DEFAULT_TELEMETRY_PATH,
  });
  if (!resolved.ok) logWarn(resolved.error ?? "telemetry.path is not inside the repository");
  return resolved.path;
}

function todayFile(dir: string): string {
  return join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

/**
 * Append one event. Never throws — telemetry failure must not affect the
 * developer's session.
 */
export function record(root: string, config: KeelConfig, event: TelemetryEventInput): void {
  try {
    if (config.telemetry.sink === "none") return;

    // The serialiser is the privacy control: it reads only the fields it
    // names, so an unexpected field cannot reach disk by any path.
    const record = serialiseEvent(event, {
      ts: new Date().toISOString(),
      version: PLUGIN_VERSION,
      repo_id: repoId(config.repo.name),
      session: currentSession(),
    });

    if (record === null) {
      logDebug("telemetry event of unknown kind dropped");
      return;
    }

    const dir = spoolDir(root, config);
    const line = `${JSON.stringify(record)}\n`;
    try {
      // The directory exists on all but the first write of a repo's life, so
      // append first and only pay for mkdir when that assumption is wrong.
      appendFileSync(todayFile(dir), line, "utf8");
    } catch {
      mkdirSync(dir, { recursive: true });
      appendFileSync(todayFile(dir), line, "utf8");
    }
  } catch {
    // Silent by design.
  }
}

/** Read every spooled event. Malformed lines are skipped, not fatal. */
export function readSpool(root: string, config: KeelConfig): TelemetryEvent[] {
  const dir = spoolDir(root, config);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const events: TelemetryEvent[] = [];
  for (const name of names.sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = parseEvent(JSON.parse(line));
        if (event !== null) events.push(event);
      } catch {
        continue;
      }
    }
  }
  return events;
}

export interface TrackDistribution {
  readonly quick: number;
  readonly standard: number;
  readonly full: number;
  readonly total: number;
  /** Share on the quick track. The plan targets 60%, and flags below 40%. */
  readonly quickShare: number;
}

export function trackDistribution(events: readonly TelemetryEvent[]): TrackDistribution {
  let quick = 0;
  let standard = 0;
  let full = 0;
  for (const e of events) {
    if (e.kind !== "route") continue;
    if (e.track === "quick") quick++;
    else if (e.track === "standard") standard++;
    else full++;
  }
  const total = quick + standard + full;
  return { quick, standard, full, total, quickShare: total === 0 ? 0 : quick / total };
}

export interface TimingSummary {
  readonly name: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/** Gate and hook timings from the last `limit` runs, for `keel doctor`. */
export function timingSummaries(
  events: readonly TelemetryEvent[],
  limit = 100,
): TimingSummary[] {
  const buckets = new Map<string, number[]>();

  // Bucket name and duration are read together so the discriminated union
  // narrows on each branch; `override` and `spike` carry no timing at all.
  const add = (name: string, durationMs: number): void => {
    const list = buckets.get(name) ?? [];
    list.push(durationMs);
    buckets.set(name, list);
  };

  for (const e of events) {
    switch (e.kind) {
      case "gate":
        add(`gate:${e.pack}`, e.duration_ms);
        break;
      case "hook_timing":
        add(`hook:${e.hook}`, e.duration_ms);
        break;
      case "tdd_gate":
        add(`tdd:${e.gate}`, e.duration_ms);
        break;
      case "route":
        add("router", e.duration_ms);
        break;
      case "mutation":
        add("mutation", e.duration_ms);
        break;
      default:
        break;
    }
  }

  const out: TimingSummary[] = [];
  for (const [name, all] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const recent = all.slice(-limit).sort((x, y) => x - y);
    out.push({
      name,
      count: recent.length,
      p50: percentile(recent, 50),
      p95: percentile(recent, 95),
      max: recent[recent.length - 1] ?? 0,
    });
  }
  return out;
}
