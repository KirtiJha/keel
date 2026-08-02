import { formatIssues, loadConfigStrict } from "../../shared/config-schema.js";
import { isGitRepo } from "../../shared/git.js";
import { loadPacks } from "../../standards/loader.js";
import { PHASE_OWNERS, auditPhases } from "../../upstream/phases.js";
import { loadLock, validateLock } from "../../upstream/lock.js";
import { detail, fail, heading, info, line, ok, warn } from "../output.js";

/**
 * `keel check` — validate config, standards packs, phase ownership and pins.
 *
 * Exits non-zero on anything invalid (M1). This is the command CI runs, so its
 * exit code has to mean something.
 */
export function check(repoRoot: string, pluginRoot: string): number {
  let errors = 0;
  let warnings = 0;

  // ---- repository ----
  heading("Repository");
  if (isGitRepo(repoRoot)) {
    ok(`git repository at ${repoRoot}`);
  } else {
    warn(`${repoRoot} is not a git repository — diff-only gates cannot run`);
    warnings++;
  }

  // ---- config ----
  heading("Configuration");
  const loaded = loadConfigStrict(repoRoot);
  if (!loaded.ok) {
    fail("keel.config.yaml is invalid");
    line(formatIssues(loaded.error));
    return 1;
  }
  const config = loaded.value.config;
  ok(`keel.config.yaml valid (${config.repo.name}, ${config.repo.languages.join(" + ")})`);
  info(`tracks: quick=${config.tracks.quick.effort} standard=${config.tracks.standard.effort} full=${config.tracks.full.effort}`);
  if (config.tdd.outer_loop) {
    warn("tdd.outer_loop is true, but integration TDD is not implemented in this version");
    warnings++;
  }

  // ---- standards packs ----
  heading("Standards packs");
  const packs = loadPacks(repoRoot, pluginRoot, config, { validate: true });

  for (const issue of packs.issues) {
    if (issue.severity === "error") {
      fail(`${issue.pack}: ${issue.path} — ${issue.message}`);
      detail(`fix: ${issue.fix}`);
      errors++;
    } else {
      warn(`${issue.pack}: ${issue.message}`);
      warnings++;
    }
  }

  if (packs.packs.length === 0) {
    warn("no standards packs found");
    warnings++;
  } else {
    for (const pack of packs.packs) {
      ok(`${pack.standard.name} (${pack.standard.mode}, ${pack.standard.severity}, owner ${pack.standard.owner})`);
    }
  }

  for (const override of packs.overrides) {
    info(`repo-local \`${override.name}\` overrides ${override.loser}`);
  }
  for (const name of packs.disabled) {
    info(`\`${name}\` disabled in config`);
  }

  // ---- phase ownership ----
  heading("Phase ownership");
  const { claims, conflicts } = auditPhases(repoRoot, pluginRoot);

  if (conflicts.length === 0) {
    ok(`no conflicts across ${claims.length} declared claim${claims.length === 1 ? "" : "s"}`);
  }
  for (const conflict of conflicts) {
    const names = [...new Set(conflict.claimants.map((c) => c.claimant))];
    fail(`phase \`${conflict.phase}\` is claimed by ${names.length} sources: ${names.join(", ")}`);
    for (const claimant of conflict.claimants) {
      detail(`${claimant.claimant} — ${claimant.source}`);
    }
    detail(`declared owner: ${PHASE_OWNERS[conflict.phase]}`);
    detail("fix: one owner per phase — disable the claim in the source that should not own it");
    errors++;
  }

  // ---- upstream pins ----
  heading("Upstream pins");
  const lock = loadLock(repoRoot);
  if (!lock.ok) {
    warn(lock.error);
    warnings++;
  } else {
    const issues = validateLock(lock.value);
    if (issues.length === 0) {
      ok(`${Object.keys(lock.value.dependencies).length} dependencies pinned and mirrored`);
    }
    for (const issue of issues) {
      if (issue.severity === "error") {
        fail(`${issue.dependency}: ${issue.message}`);
        detail(`fix: ${issue.fix}`);
        errors++;
      } else {
        warn(`${issue.dependency}: ${issue.message}`);
        detail(`fix: ${issue.fix}`);
        warnings++;
      }
    }
  }

  // ---- summary ----
  heading("Summary");
  if (errors === 0 && warnings === 0) {
    ok("all checks passed");
    return 0;
  }
  if (errors === 0) {
    warn(`${warnings} warning${warnings === 1 ? "" : "s"}, no errors`);
    return 0;
  }
  fail(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  return 1;
}
