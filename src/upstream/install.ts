import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exec } from "../shared/exec.js";
import { isDirectory, isFile } from "../shared/paths.js";
import { errorMessage, type Result, ok } from "../shared/result.js";

import { type UpstreamDependency, type UpstreamLock, installable } from "./lock.js";

/**
 * Installing the pinned upstream set (build spec M2.2).
 *
 * Keel runs the `install:` command each lock entry records — commands a human
 * wrote and reviewed, not commands Keel composes from guesses. That matters:
 * one of them registers a plugin marketplace, which is a trusted operation that
 * can execute arbitrary code, and it is not something to derive from a string
 * and hope.
 *
 * Verification is separate from installation and cheaper, so `keel check` and
 * `keel doctor` can report drift without installing anything.
 */

export type InstallKind = "npm" | "plugin" | "unknown";

/** What kind of install command this is, from its shape. */
export function classify(dependency: UpstreamDependency): InstallKind {
  const command = dependency.install ?? "";
  if (/\bnpm\s+install\b|\bnpm\s+i\b|\bpnpm\s+add\b|\byarn\s+add\b/.test(command)) return "npm";
  if (/\bplugin\s+marketplace\s+add\b|\bplugin\s+install\b/.test(command)) return "plugin";
  return "unknown";
}

/** The npm package name an install command targets, without its version. */
export function npmPackageName(dependency: UpstreamDependency): string | null {
  if (classify(dependency) !== "npm") return null;
  const match = /(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add)\s+(?:--\S+\s+)*(\S+)/.exec(
    dependency.install ?? "",
  );
  const spec = match?.[1];
  if (spec === undefined) return null;
  // Strip the version, keeping any leading scope: `@scope/name@1.2.3`.
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export type DependencyState = "installed" | "wrong-version" | "missing" | "unverifiable";

export interface DependencyStatus {
  readonly name: string;
  readonly pinned: string;
  readonly state: DependencyState;
  /** Version found on disk, when one could be read. */
  readonly found?: string;
  readonly detail: string;
}

function npmInstalledVersion(root: string, packageName: string): string | null {
  const manifest = join(root, "node_modules", ...packageName.split("/"), "package.json");
  if (!isFile(manifest)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = (parsed as Record<string, unknown>)["version"];
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Is a plugin marketplace registered?
 *
 * Best-effort, and deliberately so. Claude Code keeps its plugin cache outside
 * the repository, and reading someone's home directory to answer a status
 * question is not a trade worth making. A repo that declares the marketplace in
 * `.claude/settings.json` counts as configured; anything else is unverifiable
 * rather than missing, because reporting "missing" for something that is in
 * fact installed would send people chasing a problem they do not have.
 */
function marketplaceDeclared(root: string, source: string): boolean {
  const path = join(root, ".claude", "settings.json");
  if (!isFile(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(source);
  } catch {
    return false;
  }
}

/** Compare what is pinned against what is actually present. */
export function upstreamStatus(root: string, lock: UpstreamLock): DependencyStatus[] {
  const out: DependencyStatus[] = [];

  for (const [name, dependency] of installable(lock)) {
    const kind = classify(dependency);

    if (kind === "npm") {
      const packageName = npmPackageName(dependency);
      const found = packageName === null ? null : npmInstalledVersion(root, packageName);

      if (found === null) {
        out.push({
          name,
          pinned: dependency.version,
          state: "missing",
          detail: `not found in node_modules — run \`keel upstream install\``,
        });
      } else if (found !== dependency.version) {
        out.push({
          name,
          pinned: dependency.version,
          state: "wrong-version",
          found,
          detail: `installed ${found}, pinned ${dependency.version}`,
        });
      } else {
        out.push({
          name,
          pinned: dependency.version,
          state: "installed",
          found,
          detail: `${packageName ?? name}@${found}`,
        });
      }
      continue;
    }

    if (kind === "plugin") {
      const declared = marketplaceDeclared(root, dependency.source);
      out.push({
        name,
        pinned: dependency.version,
        state: declared ? "installed" : "unverifiable",
        detail: declared
          ? `marketplace ${dependency.source} declared in .claude/settings.json`
          : `plugin install state lives outside the repo — check with \`/plugin\``,
      });
      continue;
    }

    out.push({
      name,
      pinned: dependency.version,
      state: "unverifiable",
      detail: "no `install:` command recorded in upstream.lock",
    });
  }

  return out;
}

export interface InstallStep {
  readonly name: string;
  readonly command: string;
  readonly kind: InstallKind;
  readonly skipped: boolean;
  readonly reason: string;
}

/** What `keel upstream install` would run, and what it would skip. */
export function planInstall(root: string, lock: UpstreamLock): InstallStep[] {
  const status = new Map(upstreamStatus(root, lock).map((s) => [s.name, s]));
  const steps: InstallStep[] = [];

  for (const [name, dependency] of installable(lock)) {
    const command = dependency.install;
    if (command === undefined || command === "") {
      steps.push({
        name,
        command: "",
        kind: "unknown",
        skipped: true,
        reason: "no `install:` command recorded in upstream.lock",
      });
      continue;
    }

    const state = status.get(name)?.state;
    steps.push({
      name,
      command,
      kind: classify(dependency),
      skipped: state === "installed",
      reason: state === "installed" ? "already at the pinned version" : "",
    });
  }

  return steps;
}

export interface InstallOutcome {
  readonly step: InstallStep;
  readonly ran: boolean;
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Run the planned install steps.
 *
 * Sequential, not parallel: these mutate shared state (`node_modules`, the
 * plugin registry) and a race between them would be a genuinely confusing
 * failure to debug.
 */
export function runInstall(
  root: string,
  lock: UpstreamLock,
  options: { readonly dryRun?: boolean } = {},
): Result<InstallOutcome[], string> {
  const outcomes: InstallOutcome[] = [];

  for (const step of planInstall(root, lock)) {
    if (step.skipped || step.command === "") {
      outcomes.push({ step, ran: false, ok: true, output: "" });
      continue;
    }

    if (options.dryRun === true) {
      outcomes.push({ step, ran: false, ok: true, output: "" });
      continue;
    }

    try {
      // Installs are slow by nature; five minutes is generous but bounded.
      const res = exec("sh", ["-c", step.command], { cwd: root, timeoutMs: 300_000 });
      if (!res.ok) {
        outcomes.push({ step, ran: true, ok: false, output: res.error });
        continue;
      }
      outcomes.push({
        step,
        ran: true,
        ok: res.value.code === 0,
        output: (res.value.stderr.trim() || res.value.stdout.trim()).slice(-800),
      });
    } catch (cause) {
      outcomes.push({ step, ran: true, ok: false, output: errorMessage(cause) });
    }
  }

  return ok(outcomes);
}

/**
 * `extraKnownMarketplaces` entries derived from plugin-kind dependencies.
 *
 * Only emitted for entries that record a `marketplace_name`, because the key of
 * this map *is* the marketplace's declared name and must match the one in its
 * `marketplace.json`. Inventing a key produces settings that look configured
 * and silently do nothing, which is worse than leaving it to `/plugin`.
 */
export function marketplaceSettings(lock: UpstreamLock): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [, dependency] of installable(lock)) {
    if (classify(dependency) !== "plugin") continue;
    const name = dependency.marketplace_name;
    if (name === undefined || name === "") continue;

    // `owner/repo` is GitHub shorthand; anything else is a git URL.
    const source = /^[\w.-]+\/[\w.-]+$/.test(dependency.source)
      ? { source: "github", repo: dependency.source }
      : { source: "git", url: dependency.source };

    out[name] = { source };
  }

  return out;
}

/** True when the repo looks like it has a Claude Code plugin cache configured. */
export function pluginDirExists(root: string): boolean {
  return isDirectory(join(root, ".claude", "plugins"));
}
