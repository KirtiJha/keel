import { loadConfigOrDefaults } from "../../shared/config.js";
import { loadConfigStrict } from "../../shared/config-schema.js";
import { currentBranch, isGitRepo } from "../../shared/git.js";
import { loadPacks } from "../../standards/loader.js";
import { readSpool, timingSummaries, trackDistribution } from "../../telemetry/spool.js";
import { PLUGIN_VERSION } from "../../telemetry/spool.js";
import { gateStats, overrideStats, tddStats } from "../../telemetry/ship.js";
import { auditPhases } from "../../upstream/phases.js";
import { upstreamStatus } from "../../upstream/install.js";
import { loadLock, validateLock } from "../../upstream/lock.js";
import { branchState, clearBranch, readState, writeState } from "../../tdd/state.js";
import { listUntrustedRules } from "../../standards/trust.js";
import { detail, dim, fail, heading, info, json, line, ok, rows, warn } from "../output.js";

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

/**
 * Below this many routing decisions, the quick-share number is noise.
 *
 * The calibration claim used to fire at n=3 — one migration in a fresh repo is
 * enough to put quick share under 40% — and told the developer their router was
 * broken on their first afternoon. A claim nobody can act on is a claim that
 * teaches people to ignore the tool.
 */
const CALIBRATION_MIN_SAMPLE = 20;

export interface DoctorOptions {
  readonly json?: boolean;
  /**
   * Clear the observed-RED ledger before reporting.
   *
   * `true` drops every branch; a string drops that one branch. Absent leaves
   * the ledger alone — this is never implied by running `keel doctor`.
   */
  readonly resetTdd?: boolean | string;
}

/** What a `--reset-tdd` run destroyed, so it can be reported rather than assumed. */
interface TddReset {
  /** The branch asked for, or null when every branch was cleared. */
  readonly branch: string | null;
  /** Branches that actually held state before the reset. */
  readonly branches: number;
  /** Test files that lost their recorded run — the RED that has to be re-earned. */
  readonly expectations: number;
  /** Of those, the ones whose RED had been observed and was still valid. */
  readonly observedRed: number;
}

/**
 * Drop observed-RED history.
 *
 * `writeState` and `clearBranch` are the ledger's own reset primitives and had
 * no production caller — their doc comments named this flag for months before
 * it existed. The counts are read *before* the write, because this is
 * destructive in a way the developer feels immediately: gate 3 re-blocks the
 * next new exported symbol until its test has been watched failing again. A
 * silent reset would leave them debugging a gate that is working correctly.
 */
function resetTddLedger(repoRoot: string, target: boolean | string): TddReset {
  const before = readState(repoRoot);
  const wanted = typeof target === "string" ? target : null;
  const affected = Object.keys(before.branches).filter((name) => wanted === null || name === wanted);

  let expectations = 0;
  let observedRed = 0;
  for (const name of affected) {
    // Via `branchState`, which tolerates a hand-edited snapshot.
    for (const e of Object.values(branchState(before, name).expectations)) {
      expectations++;
      if (e.redObservedAt !== null && e.redObservedAt >= e.writtenAt) observedRed++;
    }
  }

  if (wanted === null) writeState(repoRoot, { version: 1, branches: {} });
  else clearBranch(repoRoot, wanted);

  return { branch: wanted, branches: affected.length, expectations, observedRed };
}

function reportReset(reset: TddReset): void {
  heading("TDD ledger reset");
  const files = `${reset.expectations} test file${reset.expectations === 1 ? "" : "s"}`;
  if (reset.branch === null) {
    ok(`cleared every branch: ${reset.branches} branch${reset.branches === 1 ? "" : "es"}, ${files}`);
  } else if (reset.branches === 0) {
    info(`\`${reset.branch}\` had nothing recorded — the ledger is unchanged`);
    return;
  } else {
    ok(`cleared \`${reset.branch}\`: ${files}`);
  }
  if (reset.observedRed > 0) {
    warn(
      `${reset.observedRed} of those had a valid observed RED — that evidence is gone and has to be earned again`,
    );
  }
  detail(
    "gate 3 blocks a new exported symbol until its test has been seen failing, so run the test and watch it fail before implementing",
  );
}

export function doctor(repoRoot: string, pluginRoot: string, options: DoctorOptions = {}): number {
  // Before anything reads the ledger, so what is reported below is what is
  // left rather than what was just deleted.
  const reset =
    options.resetTdd === undefined ? null : resetTddLedger(repoRoot, options.resetTdd);

  const resolved = loadConfigOrDefaults(repoRoot);
  const strict = loadConfigStrict(repoRoot);
  const asJson = options.json === true;

  const { packs, overrides, disabled } = loadPacks(repoRoot, pluginRoot, resolved.config, {
    validate: true,
  });
  const { claims, conflicts, roots } = auditPhases(repoRoot, pluginRoot);
  const untrusted = listUntrustedRules({ repoRoot, pluginRoot, config: resolved.config });
  const lock = loadLock(repoRoot);
  const events = readSpool(repoRoot, resolved.config);
  const timings = timingSummaries(events, 100);
  const distribution = trackDistribution(events);
  const gates = gateStats(events);
  const tdd = tddStats(events);

  const upstreamRows = lock.ok
    ? (() => {
        const issues = validateLock(lock.value);
        const status = new Map(upstreamStatus(repoRoot, lock.value).map((s) => [s.name, s]));
        return Object.entries(lock.value.dependencies).map(([name, dependency]) => {
          const problem = issues.find((i) => i.dependency === name && i.severity === "error");
          if (problem !== undefined) {
            return { name, version: dependency.version, state: "invalid-pin", detail: problem.message };
          }
          if (dependency.role === "pattern-source") {
            return {
              name,
              version: dependency.version,
              state: "pattern-source",
              detail: "pinned for provenance, never installed",
            };
          }
          const found = status.get(name);
          return {
            name,
            version: dependency.version,
            state: found?.state ?? "unverifiable",
            detail: found?.detail ?? "no install state could be read",
          };
        });
      })()
    : [];

  if (asJson) {
    json({
      version: PLUGIN_VERSION,
      repo: repoRoot,
      plugin: pluginRoot,
      git: isGitRepo(repoRoot),
      branch: isGitRepo(repoRoot) ? currentBranch(repoRoot) : null,
      config: strict.ok ? "valid" : resolved.present ? "invalid" : "absent",
      configIssues: strict.ok ? [] : strict.error.map((i) => ({ path: i.path, message: i.message, fix: i.fix })),
      packs: packs.map((p) => ({
        name: p.standard.name,
        mode: p.standard.mode,
        severity: p.standard.severity,
        owner: p.standard.owner,
      })),
      overrides,
      disabled,
      untrustedRules: untrusted,
      phases: {
        claims: claims.length,
        conflicts,
        inspectedRoots: roots,
        note: "frontmatter claims in the repository and plugin only; upstream tools installed outside the checkout are not visible",
      },
      upstream: lock.ok ? upstreamRows : { error: lock.error },
      timings: timings.map((t) => ({ ...t, budgetMs: budgetFor(t.name), overBudget: t.p95 > budgetFor(t.name) })),
      timingNote: "first run in a session is cold-cache; warm runs are typically 2-4x faster",
      distribution: {
        ...distribution,
        calibrationAssessed: distribution.total >= CALIBRATION_MIN_SAMPLE,
      },
      gates,
      tddGates: tdd,
      tddReset: reset,
    });
    return 0;
  }

  heading("Keel");
  rows([
    ["version", PLUGIN_VERSION],
    ["repo", repoRoot],
    ["plugin", pluginRoot],
    ["branch", isGitRepo(repoRoot) ? currentBranch(repoRoot) : dim("not a git repo")],
  ]);

  if (reset !== null) reportReset(reset);

  heading("Configuration");
  if (strict.ok) {
    ok("keel.config.yaml valid");
  } else if (!resolved.present) {
    warn("no keel.config.yaml — running on defaults (`keel init` creates one)");
  } else {
    fail("keel.config.yaml invalid — hooks are running on coerced defaults");
    for (const issue of strict.error) info(`${issue.path}: ${issue.message}`);
    detail("fix: correct the fields above, then re-run `keel check`");
  }
  rows([
    ["tdd", resolved.config.tdd.enabled ? "on (unit)" : "off"],
    ["outer loop", resolved.config.tdd.outer_loop ? "on" : dim("off — integration TDD deferred")],
    ["telemetry", `${resolved.config.telemetry.sink} → ${resolved.config.telemetry.path}`],
    ["display", resolved.config.display.enabled ? `on (${resolved.config.display.budget_ms} ms budget)` : "off"],
  ]);

  // ---- packs ----
  heading("Standards packs");
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
  for (const rule of untrusted) {
    warn(`\`${rule.pack}\` will not run — ${rule.reason} (${rule.file})`);
    detail(`fix: read the file, then \`keel trust add ${rule.pack}\``);
  }

  // ---- phase ownership ----
  heading("Phase ownership");
  if (conflicts.length === 0) {
    ok(`no conflicts (${claims.length} claims)`);
  } else {
    for (const conflict of conflicts) {
      fail(`${conflict.phase}: ${[...new Set(conflict.claimants.map((c) => c.claimant))].join(", ")}`);
      detail("fix: one owner per phase — remove the claim from the source that should not own it");
    }
  }
  info(`inspected: ${roots.length === 0 ? "no skills directories present" : roots.join(", ")}`);
  detail(
    "SKILL.md frontmatter only — Superpowers lives in Claude Code's plugin cache and OpenSpec ships slash commands, so neither is visible to this audit",
  );

  // ---- upstream ----
  heading("Upstream");
  if (!lock.ok) {
    warn(lock.error);
    detail("fix: run `keel init` — it scaffolds a starter upstream.lock for this repository");
  } else {
    for (const row of upstreamRows) {
      switch (row.state) {
        case "installed":
          ok(`${row.name} @ ${row.version} installed  ${dim(row.detail)}`);
          break;
        case "pattern-source":
          info(`${row.name} @ ${row.version}  ${dim(row.detail)}`);
          break;
        case "missing":
          warn(`${row.name} @ ${row.version} pinned but NOT installed`);
          detail("fix: run `keel upstream install`");
          break;
        case "wrong-version":
          warn(`${row.name}: ${row.detail}`);
          detail("fix: run `keel upstream install` to bring it to the pin");
          break;
        case "invalid-pin":
          fail(`${row.name}: ${row.detail}`);
          detail("fix: correct the pin in upstream.lock, then re-run `keel check`");
          break;
        default:
          info(`${row.name} @ ${row.version}  ${dim(row.detail)}`);
      }
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
  if (timings.length === 0) {
    info("no telemetry recorded yet");
  } else {
    // 12 wide, not 9: "1400.0ms !" is ten characters, and the `!` used to run
    // straight into the budget column exactly when it mattered most.
    line(`  ${dim("name".padEnd(28))}${dim("n".padEnd(6))}${dim("p50".padEnd(12))}${dim("p95".padEnd(12))}${dim("budget")}`);
    let anyOver = false;
    for (const timing of timings) {
      const budget = budgetFor(timing.name);
      const over = timing.p95 > budget;
      anyOver = anyOver || over;
      const p95 = `${timing.p95.toFixed(1)}ms`;
      line(
        `  ${timing.name.padEnd(28)}${String(timing.count).padEnd(6)}` +
          `${`${timing.p50.toFixed(1)}ms`.padEnd(12)}${(over ? `${p95} !` : p95).padEnd(12)}${budget}ms`,
      );
    }
    // The `!` used to appear with no legend and no fix, on a first run whose
    // numbers are all cold-cache. Both facts belong next to the number.
    if (anyOver) {
      detail("! marks p95 over budget");
      detail(
        "cold vs warm: the first run in a session pays module init and an empty symbol cache, and a cold number is often 2-4x a warm one — re-run before treating this as a regression",
      );
      detail("fix if it persists warm: `KEEL_DEBUG=1` to log per-stage timings, then narrow the pack or gate that dominates");
    }
  }

  // ---- distribution ----
  heading("Track distribution");
  if (distribution.total === 0) {
    info("no routing decisions recorded yet");
  } else {
    rows([
      ["quick", `${distribution.quick} (${(distribution.quickShare * 100).toFixed(0)}%)`],
      ["standard", String(distribution.standard)],
      ["full", String(distribution.full)],
    ]);

    // The plan targets 60% quick and treats below 40% as a broken router — but
    // only once there are enough decisions for the share to mean anything.
    if (distribution.total < CALIBRATION_MIN_SAMPLE) {
      info(
        `${distribution.total} routing decision${distribution.total === 1 ? "" : "s"} so far — too few to judge calibration (needs ${CALIBRATION_MIN_SAMPLE})`,
      );
    } else if (distribution.quickShare < 0.4) {
      warn("quick share is below 40% — the router is miscalibrated");
      detail("fix: widen `router.quick_max_files` / `quick_max_lines`, or narrow `force_full_globs`, in keel.config.yaml");
    } else if (distribution.quickShare >= 0.6) {
      ok("quick share is at or above the 60% target");
    }

    const overrideCounts = overrideStats(events);
    if (overrideCounts.total > 0) {
      info(`overrides: ${overrideCounts.down} down, ${overrideCounts.up} up`);
    }
  }

  // ---- gate hit rates ----
  if (gates.length > 0) {
    heading("Gate hit rates");
    rows(gates.map((g) => [g.pack, `${g.failures}/${g.runs} (${(g.hitRate * 100).toFixed(0)}%)`]));
    for (const gate of gates) {
      if (gate.runs >= 20 && gate.failures === 0) {
        info(`\`${gate.pack}\` has never fired in ${gate.runs} runs — consider deleting it`);
      }
    }
  }

  if (tdd.length > 0) {
    heading("TDD gate trips");
    rows(tdd.map((t) => [t.gate, `${t.trips} trips, ${t.overrides} overridden`]));
  }

  line();
  return 0;
}
