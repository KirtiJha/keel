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
 * The `file` sink is the only sink, and that is the decision rather than a gap
 * (docs/decisions.md §16). Telemetry is collected by default so gate hit rates
 * can be measured honestly — opt-in would sample only the teams who already
 * like Keel — and it never leaves the machine that produced it. `ship` rolls
 * the spool into a bundle on local disk; there is nowhere else for it to go.
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

export interface MutationTrend {
  readonly runs: number;
  /** Mean score across runs, for deciding when to ratchet the floor. */
  readonly meanScore: number;
  readonly lastScore: number;
  readonly failures: number;
}

/** Mutation scores over time. The floor ratchets quarterly off this. */
export function mutationTrend(events: readonly TelemetryEvent[]): MutationTrend {
  const scores: number[] = [];
  let failures = 0;
  for (const e of events) {
    if (e.kind !== "mutation") continue;
    if (e.total === 0) continue;
    scores.push(e.score);
    if (!e.passed) failures++;
  }
  const runs = scores.length;
  return {
    runs,
    meanScore: runs === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / runs,
    lastScore: scores[runs - 1] ?? 0,
    failures,
  };
}

export interface ReviewTrend {
  readonly prs: number;
  /** The plan's headline metric: human PR comments down 40%. */
  readonly meanHumanComments: number;
  readonly totalHumanComments: number;
  readonly byTrack: Readonly<Record<string, number>>;
}

/** Human PR comment counts, the plan's primary success measure. */
export function reviewTrend(events: readonly TelemetryEvent[]): ReviewTrend {
  const perTrack = new Map<string, { prs: number; comments: number }>();
  let prs = 0;
  let totalHumanComments = 0;

  for (const e of events) {
    if (e.kind !== "pr_review") continue;
    prs++;
    totalHumanComments += e.human_comments;
    const entry = perTrack.get(e.track) ?? { prs: 0, comments: 0 };
    entry.prs++;
    entry.comments += e.human_comments;
    perTrack.set(e.track, entry);
  }

  const byTrack: Record<string, number> = {};
  for (const [track, { prs: n, comments }] of perTrack) {
    byTrack[track] = n === 0 ? 0 : comments / n;
  }

  return {
    prs,
    meanHumanComments: prs === 0 ? 0 : totalHumanComments / prs,
    totalHumanComments,
    byTrack,
  };
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
