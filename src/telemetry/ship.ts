import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KeelConfig } from "../shared/config.js";
import { keelSubdir } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import { readSpool, spoolDir, trackDistribution } from "./spool.js";
import type { TelemetryEvent } from "./events.js";

/**
 * Shipping the spool.
 *
 * Separate process, separate command, never a hook — constraint 0.6 forbids
 * network calls inside hooks, so recording and shipping are different things
 * that happen at different times.
 *
 * Only the `file` sink is implemented. The real destination is a blocked input
 * (build spec §1): rather than guess an endpoint and write a speculative
 * client, `ship` writes a rolled-up bundle to a local path and reports that the
 * destination is still needed.
 */

export interface ShipSummary {
  readonly events: number;
  readonly bundlePath: string;
  readonly distribution: ReturnType<typeof trackDistribution>;
}

export function shipToFile(
  root: string,
  config: KeelConfig,
  destination?: string,
): Result<ShipSummary, string> {
  if (config.telemetry.sink === "none") {
    return err("telemetry.sink is `none` — nothing is being recorded");
  }

  const events = readSpool(root, config);
  if (events.length === 0) {
    return err(`no events in ${spoolDir(root, config)}`);
  }

  const outDir = destination ?? keelSubdir(root, "telemetry", "shipped");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bundlePath = join(outDir, `keel-telemetry-${stamp}.jsonl`);

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(bundlePath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
  } catch (cause) {
    return err(errorMessage(cause));
  }

  return ok({ events: events.length, bundlePath, distribution: trackDistribution(events) });
}

/** Move already-shipped spool files aside so they are not shipped twice. */
export function archiveSpool(root: string, config: KeelConfig): Result<number, string> {
  const dir = spoolDir(root, config);
  const archive = join(dir, "archive");
  let moved = 0;

  try {
    mkdirSync(archive, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("events-") || !name.endsWith(".jsonl")) continue;
      renameSync(join(dir, name), join(archive, name));
      moved++;
    }
  } catch (cause) {
    return err(errorMessage(cause));
  }

  return ok(moved);
}

export interface GateStats {
  readonly pack: string;
  readonly runs: number;
  readonly failures: number;
  /** Share of runs that produced a blocking finding. */
  readonly hitRate: number;
}

/** Per-pack hit rates. Rule of the road 5: delete rules that do not fire. */
export function gateStats(events: readonly TelemetryEvent[]): GateStats[] {
  const runs = new Map<string, { total: number; failures: number }>();
  for (const e of events) {
    if (e.kind !== "gate") continue;
    const entry = runs.get(e.pack) ?? { total: 0, failures: 0 };
    entry.total++;
    if (e.result === "fail") entry.failures++;
    runs.set(e.pack, entry);
  }

  return [...runs.entries()]
    .map(([pack, { total, failures }]) => ({
      pack,
      runs: total,
      failures,
      hitRate: total === 0 ? 0 : failures / total,
    }))
    .sort((a, b) => b.hitRate - a.hitRate || a.pack.localeCompare(b.pack));
}

export interface TddStats {
  readonly gate: string;
  readonly trips: number;
  readonly overrides: number;
}

/** TDD gate trips by type, and how often each was overridden. */
export function tddStats(events: readonly TelemetryEvent[]): TddStats[] {
  const byGate = new Map<string, { trips: number; overrides: number }>();
  for (const e of events) {
    if (e.kind !== "tdd_gate") continue;
    const entry = byGate.get(e.gate) ?? { trips: 0, overrides: 0 };
    if (e.result === "block") entry.trips++;
    if (e.overridden) entry.overrides++;
    byGate.set(e.gate, entry);
  }

  return [...byGate.entries()]
    .map(([gate, v]) => ({ gate, trips: v.trips, overrides: v.overrides }))
    .sort((a, b) => b.trips - a.trips || a.gate.localeCompare(b.gate));
}

/** Override rate and direction. The plan watches downward overrides. */
export function overrideStats(events: readonly TelemetryEvent[]): {
  readonly total: number;
  readonly down: number;
  readonly up: number;
} {
  let down = 0;
  let up = 0;
  for (const e of events) {
    if (e.kind !== "override") continue;
    if (e.direction === "down") down++;
    else up++;
  }
  return { total: down + up, down, up };
}
