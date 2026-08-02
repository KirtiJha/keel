import { loadConfigOrDefaults } from "../../shared/config.js";
import { mergeObjectKey, setSkillOverrides, updateSettings } from "../../shared/settings.js";
import {
  marketplaceSettings,
  planInstall,
  runInstall,
  upstreamStatus,
} from "../../upstream/install.js";
import { installable, loadLock, validateLock, type UpstreamLock } from "../../upstream/lock.js";
import { bold, detail, dim, fail, heading, info, json, line, ok, warn } from "../output.js";

/**
 * `keel upstream <status|install>` — the pinned set, verified and installed.
 *
 * Installing is its own command rather than a step inside `init` because it
 * mutates `node_modules` and registers a plugin marketplace — trusted
 * operations that should be something a person asked for, not a side effect of
 * scaffolding a config file.
 *
 * **`keel init` therefore does not install anything.** It scaffolds a starter
 * `upstream.lock` if the repo has none, and reports which pinned dependencies
 * are missing. `--no-install` skips that *report*. The flag used to be
 * documented as "skip installing the upstream set", describing behaviour that
 * did not exist in either direction.
 */

export interface UpstreamOptions {
  readonly repoRoot: string;
  readonly subcommand: string | null;
  readonly dryRun: boolean;
  readonly json: boolean;
  /**
   * Approve writing the lock's marketplaces into the committed
   * `.claude/settings.json`. Off by default: see `declareMarketplaces`.
   */
  readonly approveMarketplaces?: boolean;
}

export function upstream(options: UpstreamOptions): number {
  const lock = loadLock(options.repoRoot);
  if (!lock.ok) {
    if (options.json) {
      json({ ok: false, error: lock.error, fix: "run `keel init` to scaffold an upstream.lock" });
      return 1;
    }
    fail(lock.error);
    detail("fix: run `keel init` — it scaffolds a starter upstream.lock you then fill in");
    return 1;
  }

  const blocking = validateLock(lock.value).filter((i) => i.severity === "error");
  if (blocking.length > 0) {
    if (options.json) {
      json({ ok: false, error: "upstream.lock is not valid", issues: blocking });
      return 1;
    }
    fail("upstream.lock is not valid, so nothing was installed");
    for (const issue of blocking) {
      detail(`${issue.dependency}: ${issue.message}`);
      detail(`fix: ${issue.fix}`);
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
    if (Object.keys(lock.dependencies).length === 0) {
      info("upstream.lock records no dependencies yet");
      detail(
        "fix: add the toolchains this repository pins under `dependencies:` — `keel init` leaves the file with a worked example",
      );
    } else {
      info("nothing to install — every entry is a pattern source");
    }
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

  declareMarketplaces(options, lock, failures);

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
 * Write `extraKnownMarketplaces` into the committed project settings — but only
 * when a human has said so, and only when the install actually worked.
 *
 * Two things were wrong. The declaration was written even when the install step
 * had **failed**, so a repository advertised a marketplace that had never been
 * successfully added. And it was written with no confirmation at all: the map
 * is derived from repo-supplied `upstream.lock` content, it lands in the file
 * this code's own comment says makes "a teammate's session offer to install
 * it", and registering a marketplace is an arbitrary-code-execution surface.
 * Cloning a repository and running one command should not be able to arrange
 * that for everyone else on the team.
 *
 * So it needs `--yes`, and the message says exactly what would be written.
 */
function declareMarketplaces(options: UpstreamOptions, lock: UpstreamLock, failures: number): void {
  const marketplaces = marketplaceSettings(lock);
  const names = Object.keys(marketplaces);
  if (names.length === 0 || options.dryRun) return;

  if (failures > 0) {
    warn(`not declaring ${names.join(", ")} in .claude/settings.json — the install failed`);
    detail("fix: resolve the failure above and re-run `keel upstream install --yes`");
    return;
  }

  if (options.approveMarketplaces !== true) {
    heading("Marketplaces (not declared)");
    info(`${names.length} marketplace(s) from upstream.lock would be written to .claude/settings.json:`);
    for (const name of names) detail(`${name}: ${JSON.stringify(marketplaces[name])}`);
    detail(
      "that file is committed, so the entry asks every teammate's session to add the marketplace — a code-execution surface, from content this repository supplied",
    );
    detail("approve it explicitly with `keel upstream install --yes`");
    return;
  }

  const written = updateSettings(options.repoRoot, "project", (current) =>
    mergeObjectKey(current, "extraKnownMarketplaces", marketplaces),
  );
  if (!written.ok) {
    warn(`could not write .claude/settings.json: ${written.error}`);
    detail("fix: check the file is writable and valid JSON");
    return;
  }
  if (written.value === "unreadable") {
    warn(".claude/settings.json could not be parsed, so it was left alone");
    detail("fix: repair the JSON, then re-run `keel upstream install --yes`");
    return;
  }
  if (written.value !== "unchanged") {
    ok(`declared ${names.length} marketplace(s) in .claude/settings.json: ${names.join(", ")}`);
  }
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
