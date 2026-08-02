import { loadConfigOrDefaults } from "../../shared/config.js";
import { loadConfigStrict } from "../../shared/config-schema.js";
import { currentBranch, isGitRepo } from "../../shared/git.js";
import { loadPacks } from "../../standards/loader.js";
import { readSpool, timingSummaries, trackDistribution } from "../../telemetry/spool.js";
import { PLUGIN_VERSION } from "../../telemetry/spool.js";
import { gateStats, overrideStats, tddStats } from "../../telemetry/ship.js";
import { auditPhases } from "../../upstream/phases.js";
import { loadLock, validateLock } from "../../upstream/lock.js";
import { branchState, readState } from "../../tdd/state.js";
import { dim, fail, heading, info, line, ok, rows, warn } from "../output.js";

/**
 * `keel doctor` — what is active, and how it is behaving.
 *
 * The budget columns exist so performance claims stay measured rather than
 * assumed: if a gate is slow in real use, this is where it shows up.
 */

const BUDGETS: Readonly<Record<string, number>> = {
  "hook:post-tool-use": 600,
  "hook:pre-tool-use": 200,
  "hook:post-bash": 200,
  "hook:message-display": 100,
  "hook:session-start": 300,
  router: 150,
};

function budgetFor(name: string): number {
  if (BUDGETS[name] !== undefined) return BUDGETS[name];
  if (name.startsWith("gate:")) return 200;
  if (name.startsWith("tdd:")) return 200;
  return 500;
}

export function doctor(repoRoot: string, pluginRoot: string): number {
  heading("Keel");
  rows([
    ["version", PLUGIN_VERSION],
    ["repo", repoRoot],
    ["plugin", pluginRoot],
    ["branch", isGitRepo(repoRoot) ? currentBranch(repoRoot) : dim("not a git repo")],
  ]);

  const resolved = loadConfigOrDefaults(repoRoot);
  const strict = loadConfigStrict(repoRoot);

  heading("Configuration");
  if (strict.ok) {
    ok("keel.config.yaml valid");
  } else if (!resolved.present) {
    warn("no keel.config.yaml — running on defaults (`keel init` creates one)");
  } else {
    fail("keel.config.yaml invalid — hooks are running on coerced defaults");
    for (const issue of strict.error) info(`${issue.path}: ${issue.message}`);
  }
  rows([
    ["tdd", resolved.config.tdd.enabled ? "on (unit)" : "off"],
    ["outer loop", resolved.config.tdd.outer_loop ? "on" : dim("off — integration TDD deferred")],
    ["telemetry", `${resolved.config.telemetry.sink} → ${resolved.config.telemetry.path}`],
    ["display", resolved.config.display.enabled ? `on (${resolved.config.display.budget_ms} ms budget)` : "off"],
  ]);

  // ---- packs ----
  heading("Standards packs");
  const { packs, overrides, disabled } = loadPacks(repoRoot, pluginRoot, resolved.config, {
    validate: true,
  });
  if (packs.length === 0) {
    warn("none found");
  } else {
    rows(
      packs.map((p) => [
        p.standard.name,
        `${p.standard.mode.padEnd(6)} ${p.standard.severity.padEnd(6)} ${dim(p.standard.owner)}`,
      ]),
    );
  }
  for (const o of overrides) info(`\`${o.name}\` overridden by ${o.winner}`);
  for (const name of disabled) info(`\`${name}\` disabled`);

  // ---- phase ownership ----
  heading("Phase ownership");
  const { claims, conflicts } = auditPhases(repoRoot, pluginRoot);
  if (conflicts.length === 0) {
    ok(`no conflicts (${claims.length} claims)`);
  } else {
    for (const conflict of conflicts) {
      fail(`${conflict.phase}: ${[...new Set(conflict.claimants.map((c) => c.claimant))].join(", ")}`);
    }
  }

  // ---- upstream ----
  heading("Upstream");
  const lock = loadLock(repoRoot);
  if (!lock.ok) {
    warn(lock.error);
  } else {
    const issues = validateLock(lock.value);
    for (const [name, dependency] of Object.entries(lock.value.dependencies)) {
      const problem = issues.find((i) => i.dependency === name && i.severity === "error");
      if (problem === undefined) ok(`${name} @ ${dependency.version}`);
      else fail(`${name}: ${problem.message}`);
    }
  }

  // ---- TDD state ----
  if (isGitRepo(repoRoot)) {
    heading("TDD state (this branch)");
    const branch = branchState(readState(repoRoot), currentBranch(repoRoot));
    const expectations = Object.entries(branch.expectations);
    if (expectations.length === 0) {
      info("no test expectations recorded");
    } else {
      rows(
        expectations.map(([file, e]) => [
          file,
          e.redObservedAt === null
            ? dim("no failing run observed")
            : e.redObservedAt < e.writtenAt
              ? "edited since the last failing run"
              : "red observed",
        ]),
      );
    }
  }

  // ---- timings ----
  heading("Timings (last 100 runs)");
  const events = readSpool(repoRoot, resolved.config);
  const timings = timingSummaries(events, 100);

  if (timings.length === 0) {
    info("no telemetry recorded yet");
  } else {
    line(`  ${dim("name".padEnd(28))}${dim("n".padEnd(6))}${dim("p50".padEnd(9))}${dim("p95".padEnd(9))}${dim("budget")}`);
    for (const timing of timings) {
      const budget = budgetFor(timing.name);
      const over = timing.p95 > budget;
      const p95 = `${timing.p95.toFixed(1)}ms`;
      line(
        `  ${timing.name.padEnd(28)}${String(timing.count).padEnd(6)}` +
          `${`${timing.p50.toFixed(1)}ms`.padEnd(9)}${(over ? `${p95} !` : p95).padEnd(9)}${budget}ms`,
      );
    }
  }

  // ---- distribution ----
  heading("Track distribution");
  const distribution = trackDistribution(events);
  if (distribution.total === 0) {
    info("no routing decisions recorded yet");
  } else {
    rows([
      ["quick", `${distribution.quick} (${(distribution.quickShare * 100).toFixed(0)}%)`],
      ["standard", String(distribution.standard)],
      ["full", String(distribution.full)],
    ]);
    // The plan targets 60% quick and treats below 40% as a broken router.
    if (distribution.quickShare < 0.4) {
      warn("quick share is below 40% — the router is miscalibrated");
    } else if (distribution.quickShare >= 0.6) {
      ok("quick share is at or above the 60% target");
    }

    const overrideCounts = overrideStats(events);
    if (overrideCounts.total > 0) {
      info(`overrides: ${overrideCounts.down} down, ${overrideCounts.up} up`);
    }
  }

  // ---- gate hit rates ----
  const gates = gateStats(events);
  if (gates.length > 0) {
    heading("Gate hit rates");
    rows(gates.map((g) => [g.pack, `${g.failures}/${g.runs} (${(g.hitRate * 100).toFixed(0)}%)`]));
    for (const gate of gates) {
      if (gate.runs >= 20 && gate.failures === 0) {
        info(`\`${gate.pack}\` has never fired in ${gate.runs} runs — consider deleting it`);
      }
    }
  }

  const tdd = tddStats(events);
  if (tdd.length > 0) {
    heading("TDD gate trips");
    rows(tdd.map((t) => [t.gate, `${t.trips} trips, ${t.overrides} overridden`]));
  }

  line();
  return 0;
}
