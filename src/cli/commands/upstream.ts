import { loadConfigOrDefaults } from "../../shared/config.js";
import { mergeObjectKey, setSkillOverrides, updateSettings } from "../../shared/settings.js";
import {
  marketplaceSettings,
  planInstall,
  runInstall,
  upstreamStatus,
} from "../../upstream/install.js";
import { installable, loadLock, validateLock, type UpstreamLock } from "../../upstream/lock.js";
import { bold, detail, dim, fail, heading, info, line, ok } from "../output.js";

/**
 * `keel upstream <status|install>` — the pinned set, verified and installed.
 *
 * Build spec M2.2: "`keel init` installs the pinned set." Installing is split
 * into its own command rather than buried in `init` because it mutates
 * `node_modules` and registers a plugin marketplace — trusted operations that
 * should be something a person asked for, not a side effect of scaffolding.
 * `keel init` calls it unless `--no-install` is passed.
 */

export interface UpstreamOptions {
  readonly repoRoot: string;
  readonly subcommand: string | null;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export function upstream(options: UpstreamOptions): number {
  const lock = loadLock(options.repoRoot);
  if (!lock.ok) {
    fail(lock.error);
    detail("run `keel init`, or add an upstream.lock recording the pinned set");
    return 1;
  }

  const blocking = validateLock(lock.value).filter((i) => i.severity === "error");
  if (blocking.length > 0) {
    fail("upstream.lock is not valid, so nothing was installed");
    for (const issue of blocking) {
      detail(`${issue.dependency}: ${issue.message}`);
    }
    return 1;
  }

  switch (options.subcommand) {
    case "status":
    case null:
      return upstreamStatusCommand(options, lock.value);
    case "install":
      return upstreamInstall(options, lock.value);
    default:
      fail(`unknown subcommand \`${options.subcommand}\` — expected status or install`);
      return 1;
  }
}

function upstreamStatusCommand(options: UpstreamOptions, lock: UpstreamLock): number {
  const status = upstreamStatus(options.repoRoot, lock);

  if (options.json) {
    line(JSON.stringify(status));
    return status.some((s) => s.state === "missing" || s.state === "wrong-version") ? 1 : 0;
  }

  heading("Upstream");
  if (status.length === 0) {
    info("nothing to install — every entry is a pattern source");
    line();
    return 0;
  }

  for (const entry of status) {
    switch (entry.state) {
      case "installed":
        ok(`${entry.name} @ ${entry.pinned}  ${dim(entry.detail)}`);
        break;
      case "wrong-version":
        fail(`${entry.name}: ${entry.detail}`);
        detail("run `keel upstream install` to bring it to the pin");
        break;
      case "missing":
        fail(`${entry.name} @ ${entry.pinned} is not installed`);
        detail(entry.detail);
        break;
      case "unverifiable":
        info(`${entry.name} @ ${entry.pinned}  ${dim(entry.detail)}`);
        break;
    }
  }

  line();
  return status.some((s) => s.state === "missing" || s.state === "wrong-version") ? 1 : 0;
}

function upstreamInstall(options: UpstreamOptions, lock: UpstreamLock): number {
  heading(options.dryRun ? "Upstream install (dry run)" : "Upstream install");

  const plan = planInstall(options.repoRoot, lock);
  if (plan.length === 0) {
    info("nothing to install — every entry is a pattern source");
    line();
    return 0;
  }

  for (const step of plan) {
    if (step.skipped) {
      info(`${step.name}  ${dim(step.reason)}`);
    } else {
      line(`  ${bold(step.name)}  ${dim(step.command)}`);
    }
  }
  line();

  const result = runInstall(options.repoRoot, lock, { dryRun: options.dryRun });
  if (!result.ok) {
    fail(result.error);
    return 1;
  }

  let failures = 0;
  if (!options.dryRun) {
    heading("Result");
    for (const outcome of result.value) {
      if (!outcome.ran) continue;
      if (outcome.ok) {
        ok(`${outcome.step.name} installed`);
      } else {
        failures++;
        fail(`${outcome.step.name} failed`);
        if (outcome.output !== "") detail(outcome.output);
      }
    }
    if (result.value.every((o) => !o.ran)) info("everything was already at its pin");
  }

  // Declaring the marketplace in project settings is what makes a teammate's
  // session offer to install it; the plugin itself still installs per person.
  const marketplaces = marketplaceSettings(lock);
  if (Object.keys(marketplaces).length > 0 && !options.dryRun) {
    const written = updateSettings(options.repoRoot, "project", (current) =>
      mergeObjectKey(current, "extraKnownMarketplaces", marketplaces),
    );
    if (written.ok && written.value !== "unchanged") {
      ok(`declared ${Object.keys(marketplaces).length} marketplace(s) in .claude/settings.json`);
    }
  }

  const pluginSteps = plan.filter((s) => s.kind === "plugin" && !s.skipped);
  if (pluginSteps.length > 0) {
    heading("Next");
    line("  A marketplace only makes plugins *available*. Install the plugin itself:");
    line();
    line(`    ${dim("/plugin")}                 browse and install interactively`);
    line(`    ${dim("claude plugin install <name>@<marketplace> --scope project")}`);
    line();
    line("  Then `/reload-plugins` to activate it in the current session.");
    line();
  }

  return failures > 0 ? 1 : 0;
}

/**
 * Apply the configured Superpowers skill subset (build spec M2.4).
 *
 * Called from `keel init`. Returns human-readable notes rather than printing,
 * so init controls the output.
 *
 * **The honest limitation:** `skillOverrides` does not affect plugin skills, and
 * Superpowers ships as a plugin. Its skills therefore cannot be subset from
 * settings at all — Claude Code manages them through `/plugin`, whole-plugin.
 * Keel writes overrides for skills it *can* control and says plainly that the
 * rest is not a setting. Writing overrides that silently do nothing would be
 * worse than not writing them.
 */
export function applySkillSubset(repoRoot: string): string[] {
  const { config } = loadConfigOrDefaults(repoRoot);
  const notes: string[] = [];

  const disabled = config.upstream.disabled_skills;
  if (disabled.length === 0) return notes;

  const overrides: Record<string, "off"> = {};
  for (const name of disabled) overrides[name] = "off";

  const written = setSkillOverrides(repoRoot, overrides);
  if (written.ok && written.value !== "unchanged" && written.value !== "unreadable") {
    notes.push(
      `skillOverrides: ${disabled.length} skill(s) set to "off" in .claude/settings.local.json`,
    );
  }

  notes.push(
    "note: skillOverrides does not apply to plugin skills — Superpowers ships as a " +
      "plugin, so manage its skills with `/plugin`, not settings",
  );

  return notes;
}

/** Whether the lock has anything worth installing at all. */
export function hasInstallableUpstream(repoRoot: string): boolean {
  const lock = loadLock(repoRoot);
  return lock.ok && installable(lock.value).length > 0;
}

/** Report unresolved warnings for `keel check`. */
export function upstreamInstallWarnings(repoRoot: string): string[] {
  const lock = loadLock(repoRoot);
  if (!lock.ok) return [];

  return upstreamStatus(repoRoot, lock.value)
    .filter((s) => s.state === "missing" || s.state === "wrong-version")
    .map((s) => `${s.name}: ${s.detail}`);
}
