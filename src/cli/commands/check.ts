import { formatIssues, loadConfigStrict } from "../../shared/config-schema.js";
import { isGitRepo } from "../../shared/git.js";
import { loadPacks } from "../../standards/loader.js";
import { listUntrustedRules } from "../../standards/trust.js";
import { PHASE_OWNERS, auditPhases } from "../../upstream/phases.js";
import { upstreamStatus } from "../../upstream/install.js";
import { loadLock, validateLock } from "../../upstream/lock.js";
import { detail, fail, heading, info, json, line, ok, warn } from "../output.js";

/**
 * `keel check` — validate config, standards packs, phase ownership and pins.
 *
 * Exits non-zero on anything invalid (M1). This is the command CI runs, so its
 * exit code has to mean something — and so does `--json`, which CI reads.
 */

export interface CheckOptions {
  readonly json?: boolean;
}

type Level = "ok" | "info" | "warn" | "error";

interface Finding {
  readonly section: string;
  readonly level: Level;
  readonly message: string;
  readonly fix?: string;
}

/** Every message carries its fix. `check` is where people go when stuck. */
function record(out: Finding[], section: string, level: Level, message: string, fix?: string): void {
  out.push({ section, level, message, ...(fix === undefined ? {} : { fix }) });
}

export function check(repoRoot: string, pluginRoot: string, options: CheckOptions = {}): number {
  const findings: Finding[] = [];
  const asJson = options.json === true;

  // ---- repository ----
  if (isGitRepo(repoRoot)) {
    record(findings, "Repository", "ok", `git repository at ${repoRoot}`);
  } else {
    record(
      findings,
      "Repository",
      "warn",
      `${repoRoot} is not a git repository — diff-only gates cannot run`,
      "run `git init && git add -A && git commit -m \"initial\"` here; gates evaluate a diff, and without a repository there is none",
    );
  }

  // ---- config ----
  const loaded = loadConfigStrict(repoRoot);
  if (!loaded.ok) {
    if (asJson) {
      json({
        ok: false,
        errors: 1,
        warnings: 0,
        findings: [
          ...findings,
          ...loaded.error.map((issue) => ({
            section: "Configuration",
            level: "error" as const,
            message: `${issue.path}: ${issue.message}`,
            fix: issue.fix,
          })),
        ],
      });
      return 1;
    }
    render(findings);
    heading("Configuration");
    fail("keel.config.yaml is invalid");
    line(formatIssues(loaded.error));
    return 1;
  }

  const config = loaded.value.config;
  record(
    findings,
    "Configuration",
    "ok",
    `keel.config.yaml valid (${config.repo.name}, ${config.repo.languages.join(" + ")})`,
  );
  record(
    findings,
    "Configuration",
    "info",
    `tracks: quick=${config.tracks.quick.effort} standard=${config.tracks.standard.effort} full=${config.tracks.full.effort}`,
  );
  if (config.tdd.outer_loop) {
    record(
      findings,
      "Configuration",
      "warn",
      "tdd.outer_loop is true, but integration TDD is not implemented in this version",
      "set `tdd.outer_loop: false` until a harness exists — see keel-plan.md",
    );
  }

  // ---- standards packs ----
  const packs = loadPacks(repoRoot, pluginRoot, config, { validate: true });

  for (const issue of packs.issues) {
    record(
      findings,
      "Standards packs",
      issue.severity === "error" ? "error" : "warn",
      issue.severity === "error"
        ? `${issue.pack}: ${issue.path} — ${issue.message}`
        : `${issue.pack}: ${issue.message}`,
      issue.fix,
    );
  }

  if (packs.packs.length === 0) {
    record(
      findings,
      "Standards packs",
      "warn",
      "no standards packs found",
      "check `standards.dirs` in keel.config.yaml, or run `keel init` to pick up the packs shipped with the plugin",
    );
  } else {
    for (const pack of packs.packs) {
      record(
        findings,
        "Standards packs",
        "ok",
        `${pack.standard.name} (${pack.standard.mode}, ${pack.standard.severity}, owner ${pack.standard.owner})`,
      );
    }
  }

  for (const override of packs.overrides) {
    record(findings, "Standards packs", "info", `repo-local \`${override.name}\` overrides ${override.loser}`);
  }
  for (const name of packs.disabled) {
    record(findings, "Standards packs", "info", `\`${name}\` disabled in config`);
  }

  // ---- pack rules awaiting approval ----
  // A repo-local rule that has not been approved does not run, and a gate that
  // does not run must never look like a gate that passed.
  const untrusted = listUntrustedRules({ repoRoot, pluginRoot, config });
  for (const rule of untrusted) {
    record(
      findings,
      "Standards packs",
      "warn",
      `\`${rule.pack}\` will not run: ${rule.reason} (${rule.file}, sha256:${rule.sha256?.slice(0, 16) ?? "unreadable"})`,
      `read the file, then run \`keel trust add ${rule.pack}\` — repo-local rules execute automatically on edit`,
    );
  }

  // ---- phase ownership ----
  const { claims, conflicts, roots } = auditPhases(repoRoot, pluginRoot);

  if (conflicts.length === 0) {
    record(
      findings,
      "Phase ownership",
      "ok",
      `no conflicts across ${claims.length} declared claim${claims.length === 1 ? "" : "s"}`,
    );
  }
  // The audit reads SKILL.md frontmatter in the repository and the plugin. It
  // cannot see Superpowers (installed into Claude Code's plugin cache, outside
  // any checkout) or OpenSpec (which ships slash commands, not skills), so a
  // clean result means "nothing in these directories conflicts" and not "the
  // installed toolchain was verified". Saying which is which is the whole value.
  record(
    findings,
    "Phase ownership",
    "info",
    `inspected ${roots.length} skill director${roots.length === 1 ? "y" : "ies"}: ${roots.length === 0 ? "none present" : roots.join(", ")}`,
  );
  record(
    findings,
    "Phase ownership",
    "info",
    "frontmatter claims only — upstream tools installed outside the repo (Superpowers' plugin cache, OpenSpec's slash commands) are not visible here",
  );

  for (const conflict of conflicts) {
    const names = [...new Set(conflict.claimants.map((c) => c.claimant))];
    record(
      findings,
      "Phase ownership",
      "error",
      `phase \`${conflict.phase}\` is claimed by ${names.length} sources: ${names.join(", ")}`,
      `one owner per phase (declared owner: ${PHASE_OWNERS[conflict.phase]}) — disable the claim in the source that should not own it: ${conflict.claimants.map((c) => `${c.claimant} in ${c.source}`).join("; ")}`,
    );
  }

  // ---- upstream pins ----
  const lock = loadLock(repoRoot);
  if (!lock.ok) {
    record(
      findings,
      "Upstream pins",
      "warn",
      lock.error,
      "run `keel init` — it scaffolds a starter upstream.lock you then fill in with the versions this repo pins",
    );
  } else {
    const issues = validateLock(lock.value);
    const status = new Map(upstreamStatus(repoRoot, lock.value).map((s) => [s.name, s]));

    for (const [name, dependency] of Object.entries(lock.value.dependencies)) {
      const failed = issues.some((i) => i.dependency === name && i.severity === "error");
      if (failed) continue;

      if (dependency.role === "pattern-source") {
        record(findings, "Upstream pins", "ok", `${name} @ ${dependency.version} (pattern source, not installed)`);
        continue;
      }

      const owns = dependency.owns.length > 0 ? ` owns ${dependency.owns.join(", ")}` : "";
      const state = status.get(name);

      // Validating the *pin* was never the same question as whether the thing
      // is installed. `check` used to answer only the first and print a tick.
      switch (state?.state) {
        case "installed":
          record(findings, "Upstream pins", "ok", `${name} @ ${dependency.version} installed${owns}`);
          break;
        case "wrong-version":
          record(
            findings,
            "Upstream pins",
            "warn",
            `${name} @ ${dependency.version} — ${state.detail}`,
            "run `keel upstream install` to bring it to the pin",
          );
          break;
        case "missing":
          record(
            findings,
            "Upstream pins",
            "warn",
            `${name} @ ${dependency.version} is pinned but NOT installed${owns}`,
            "run `keel upstream install`",
          );
          break;
        default:
          record(
            findings,
            "Upstream pins",
            "info",
            `${name} @ ${dependency.version}${owns} — install state unverifiable from the repository`,
            state?.detail ?? "verify with `/plugin` inside Claude Code; the plugin cache lives outside this checkout",
          );
      }
    }

    for (const issue of issues) {
      record(
        findings,
        "Upstream pins",
        issue.severity === "error" ? "error" : "warn",
        `${issue.dependency}: ${issue.message}`,
        issue.fix,
      );
    }
  }

  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;

  if (asJson) {
    json({ ok: errors === 0, errors, warnings, findings });
    return errors > 0 ? 1 : 0;
  }

  render(findings);

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

function render(findings: readonly Finding[]): void {
  let section = "";
  for (const finding of findings) {
    if (finding.section !== section) {
      heading(finding.section);
      section = finding.section;
    }
    switch (finding.level) {
      case "ok":
        ok(finding.message);
        break;
      case "info":
        info(finding.message);
        break;
      case "warn":
        warn(finding.message);
        break;
      case "error":
        fail(finding.message);
        break;
    }
    if (finding.fix !== undefined) detail(`fix: ${finding.fix}`);
  }
}
