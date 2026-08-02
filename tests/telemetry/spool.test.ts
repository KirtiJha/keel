import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { repoId } from "../../src/telemetry/events.js";
import {
  readSpool,
  record,
  spoolDir,
  timingSummaries,
  trackDistribution,
} from "../../src/telemetry/spool.js";
import { gateStats, overrideStats, shipToFile, tddStats } from "../../src/telemetry/ship.js";

import { TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-telemetry-");
  delete process.env["KEEL_SESSION_ID"];
});

afterEach(() => {
  repo.dispose();
  delete process.env["KEEL_SESSION_ID"];
});

/** Everything on disk in the spool. An absent directory means nothing was written. */
function spoolText(): string {
  const dir = spoolDir(repo.root, repo.config());
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => readFileSync(join(dir, n), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

describe("recording", () => {
  it("appends a route event and reads it back", () => {
    record(repo.root, repo.config(), {
      kind: "route",
      track: "quick",
      reason_count: 1,
      changed_files: 1,
      changed_lines: 12,
      duration_ms: 40,
    });

    const events = readSpool(repo.root, repo.config());
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("route");
  });

  it("stamps every event with version, repo id and session", () => {
    record(repo.root, repo.config(), { kind: "spike", enabled: true });
    const event = readSpool(repo.root, repo.config())[0];

    expect(event?.version).toBe("0.1.0");
    expect(event?.repo_id).toBe(repoId("temp-repo"));
    expect(event?.session).toMatch(/.+/);
  });

  it("hashes the repo name rather than storing it", () => {
    record(repo.root, repo.config(), { kind: "spike", enabled: true });
    expect(spoolText()).not.toContain("temp-repo");
    expect(spoolText()).toContain(repoId("temp-repo"));
  });

  it("writes nothing when the sink is none", () => {
    const config = repo.config();
    record(repo.root, { ...config, telemetry: { ...config.telemetry, sink: "none" } }, {
      kind: "spike",
      enabled: true,
    });
    expect(readSpool(repo.root, config)).toEqual([]);
  });

  it("never throws, whatever happens", () => {
    expect(() =>
      record("/nonexistent/path/that/cannot/be/written", repo.config(), {
        kind: "spike",
        enabled: true,
      }),
    ).not.toThrow();
  });

  it("skips malformed lines when reading", () => {
    record(repo.root, repo.config(), { kind: "spike", enabled: true });
    const dir = spoolDir(repo.root, repo.config());
    const file = readdirSync(dir).find((n) => n.endsWith(".jsonl")) ?? "";
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(join(dir, file), "{ not json\n", "utf8");

    expect(readSpool(repo.root, repo.config())).toHaveLength(1);
  });
});

describe("M8 acceptance — the spool contains no source code", () => {
  it("rejects any event carrying a field outside the schema", () => {
    const SECRET_SOURCE = "export function chargeCustomer() { return SECRET_API_KEY; }";

    // Every shape a careless call site might try.
    const smuggleAttempts: unknown[] = [
      { kind: "gate", pack: "p", severity: "high", result: "fail", finding_count: 1, duration_ms: 1, snippet: SECRET_SOURCE },
      { kind: "gate", pack: "p", severity: "high", result: "fail", finding_count: 1, duration_ms: 1, file_path: "src/secret/path.ts" },
      { kind: "route", track: "quick", reason_count: 1, changed_files: 1, changed_lines: 1, duration_ms: 1, reasons: [SECRET_SOURCE] },
      { kind: "spike", enabled: true, prompt: SECRET_SOURCE },
      { kind: "tdd_gate", gate: "observed-red", result: "block", overridden: false, duration_ms: 1, diff: SECRET_SOURCE },
    ];

    for (const attempt of smuggleAttempts) {
      record(repo.root, repo.config(), attempt as never);
    }

    // The serialiser reads only the fields it names, so the smuggled ones have
    // no path to disk. The legitimate fields of each event are still recorded.
    const text = spoolText();
    expect(text).not.toContain(SECRET_SOURCE);
    expect(text).not.toContain("SECRET_API_KEY");
    expect(text).not.toContain("src/secret/path.ts");
    expect(text).not.toContain("snippet");
    expect(text).not.toContain("file_path");
    expect(text).not.toContain("reasons");
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("diff");

    for (const event of readSpool(repo.root, repo.config())) {
      for (const key of Object.keys(event)) {
        expect(key).not.toMatch(/snippet|file_path|reasons|prompt|diff/);
      }
    }
  });

  it("accepts only the documented fields on a valid event", () => {
    record(repo.root, repo.config(), {
      kind: "gate",
      pack: "no-raw-color-values",
      severity: "high",
      result: "fail",
      finding_count: 2,
      duration_ms: 31,
    });

    const event = readSpool(repo.root, repo.config())[0];
    expect(Object.keys(event ?? {}).sort()).toEqual(
      [
        "duration_ms",
        "finding_count",
        "kind",
        "pack",
        "repo_id",
        "result",
        "session",
        "severity",
        "ts",
        "version",
      ].sort(),
    );
  });

  it("records no file paths anywhere in the schema", () => {
    // A structural check: no event type may declare a path-shaped field.
    record(repo.root, repo.config(), {
      kind: "gate",
      pack: "p",
      severity: "low",
      result: "pass",
      finding_count: 0,
      duration_ms: 1,
    });
    record(repo.root, repo.config(), {
      kind: "tdd_gate",
      gate: "assertion-lint",
      result: "pass",
      overridden: false,
      duration_ms: 1,
    });

    for (const event of readSpool(repo.root, repo.config())) {
      for (const key of Object.keys(event)) {
        expect(key).not.toMatch(/path|file|dir|source|content|snippet|prompt|diff/i);
      }
    }
  });
});

describe("aggregation", () => {
  function seed(): void {
    const config = repo.config();
    for (const track of ["quick", "quick", "quick", "standard", "full"] as const) {
      record(repo.root, config, {
        kind: "route",
        track,
        reason_count: 1,
        changed_files: 1,
        changed_lines: 10,
        duration_ms: 20,
      });
    }
    record(repo.root, config, { kind: "override", from: "full", to: "quick", direction: "down" });
    record(repo.root, config, { kind: "override", from: "quick", to: "full", direction: "up" });
    for (const result of ["pass", "pass", "fail"] as const) {
      record(repo.root, config, {
        kind: "gate",
        pack: "no-raw-color-values",
        severity: "high",
        result,
        finding_count: result === "fail" ? 1 : 0,
        duration_ms: 25,
      });
    }
    record(repo.root, config, {
      kind: "tdd_gate",
      gate: "observed-red",
      result: "block",
      overridden: false,
      duration_ms: 5,
    });
    record(repo.root, config, {
      kind: "tdd_gate",
      gate: "test-weakening",
      result: "block",
      overridden: true,
      duration_ms: 5,
    });
  }

  it("computes the track distribution the plan measures", () => {
    seed();
    const distribution = trackDistribution(readSpool(repo.root, repo.config()));
    expect(distribution.total).toBe(5);
    expect(distribution.quick).toBe(3);
    expect(distribution.quickShare).toBeCloseTo(0.6);
  });

  it("computes gate hit rates so unfired rules can be deleted", () => {
    seed();
    const stats = gateStats(readSpool(repo.root, repo.config()));
    expect(stats[0]?.pack).toBe("no-raw-color-values");
    expect(stats[0]?.runs).toBe(3);
    expect(stats[0]?.hitRate).toBeCloseTo(1 / 3);
  });

  it("computes TDD trips by type and override counts", () => {
    seed();
    const stats = tddStats(readSpool(repo.root, repo.config()));
    expect(stats.find((s) => s.gate === "observed-red")?.trips).toBe(1);
    expect(stats.find((s) => s.gate === "test-weakening")?.overrides).toBe(1);
  });

  it("computes override rate and direction", () => {
    seed();
    const stats = overrideStats(readSpool(repo.root, repo.config()));
    expect(stats).toEqual({ total: 2, down: 1, up: 1 });
  });

  it("computes timing percentiles for keel doctor", () => {
    seed();
    const summaries = timingSummaries(readSpool(repo.root, repo.config()));
    const router = summaries.find((s) => s.name === "router");
    expect(router?.count).toBe(5);
    expect(router?.p95).toBeGreaterThan(0);
  });
});

describe("shipping", () => {
  it("writes a bundle and reports the distribution", () => {
    record(repo.root, repo.config(), {
      kind: "route",
      track: "quick",
      reason_count: 1,
      changed_files: 1,
      changed_lines: 3,
      duration_ms: 10,
    });

    const result = shipToFile(repo.root, repo.config());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toBe(1);
    expect(readFileSync(result.value.bundlePath, "utf8")).toContain('"kind":"route"');
  });

  it("explains an empty spool rather than writing an empty bundle", () => {
    const result = shipToFile(repo.root, repo.config());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no events");
  });

  it("refuses when the sink is switched off", () => {
    const config = repo.config();
    const result = shipToFile(repo.root, { ...config, telemetry: { ...config.telemetry, sink: "none" } });
    expect(result.ok).toBe(false);
  });
});
