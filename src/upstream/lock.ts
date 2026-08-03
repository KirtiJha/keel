import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isFile } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import { PHASES, PHASE_OWNERS, type Phase } from "./phases.js";

/**
 * `upstream.lock` — pinned versions of the upstream toolchains Keel composes.
 *
 * Rule of the road 6: compose, don't fork. Pin, mirror, never patch.
 * Rule of the road 7: one owner per phase.
 *
 * Both rules are enforced here rather than trusted. `validateLock` rejects
 * moving versions *and* cross-checks each dependency's declared `owns` against
 * the phase-ownership map, so a second tool claiming an owned phase fails
 * `keel check` instead of being discovered later as degraded output.
 */

export const UNPINNED = "UNPINNED" as const;

/**
 * What a dependency is *for*.
 *
 * `install` — Keel installs it and it owns phases of the workflow.
 * `pattern-source` — we took ideas from it. Pinned for provenance, installs
 *   nothing, owns nothing. Spec Kit is this: the plan takes "two ideas only"
 *   from it, and installing it would put a second owner on design and planning.
 */
export const ROLES = ["install", "pattern-source"] as const;
const DependencySchema = z
  .object({
    /** Semver, a git tag, or the literal `UNPINNED` until a human supplies one. */
    version: z.string().min(1),
    source: z.string().min(1),
    role: z.enum(ROLES).default("install"),
    /** How it is installed. Run verbatim by `keel upstream install`. */
    install: z.string().optional(),
    /**
     * The marketplace's own declared name, for plugin-kind dependencies.
     *
     * Required before Keel will write an `extraKnownMarketplaces` entry: the
     * key of that map *is* the marketplace's name and must match the one in its
     * `marketplace.json`. Left unset, the marketplace is added by the recorded
     * `install:` command instead and nothing is guessed.
     */
    marketplace_name: z.string().optional(),
    /** Internal mirror, per "pin upstream versions, mirror internally". */
    mirror: z.string().optional(),
    /** Phases this dependency owns; cross-checked against PHASE_OWNERS. */
    owns: z.array(z.string()).default([]),
    /** Why this version, or why this is only a pattern source. */
    note: z.string().optional(),
  })
  .strict();

export const UpstreamLockSchema = z
  .object({
    version: z.literal(1),
    dependencies: z.record(z.string(), DependencySchema),
  })
  .strict();

export type UpstreamLock = z.infer<typeof UpstreamLockSchema>;
export type UpstreamDependency = z.infer<typeof DependencySchema>;

export function lockPath(root: string): string {
  return join(root, "upstream.lock");
}

export function loadLock(root: string): Result<UpstreamLock, string> {
  const path = lockPath(root);
  if (!isFile(path)) return err(`no upstream.lock at ${path}`);

  try {
    const parsed = UpstreamLockSchema.safeParse(parseYaml(readFileSync(path, "utf8")));
    if (!parsed.success) {
      return err(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    return ok(parsed.data);
  } catch (cause) {
    return err(errorMessage(cause));
  }
}

export interface LockIssue {
  readonly dependency: string;
  readonly message: string;
  readonly fix: string;
  readonly severity: "error" | "warning";
}

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

/** A command that registers or installs a Claude Code plugin. */
const PLUGIN_INSTALL = /\bplugin\s+(?:marketplace\s+add|install)\b/;

/** Does the command carry the pinned version, with or without a leading `v`? */
function mentionsVersion(command: string, version: string): boolean {
  const bare = version.replace(/^v/, "");
  return command.includes(bare);
}

/**
 * Validate pins and phase ownership.
 *
 * `latest` and floating ranges are errors, not warnings: an unpinned upstream
 * means the toolchain can change under a team without a commit, which is the
 * exact failure "compose, don't fork" exists to prevent.
 */
export function validateLock(lock: UpstreamLock): LockIssue[] {
  const issues: LockIssue[] = [];
  /** phase -> dependencies claiming it, for the two-owners check. */
  const claims = new Map<string, string[]>();

  for (const [name, dependency] of Object.entries(lock.dependencies)) {
    // ---- version pinning ----
    if (dependency.version === UNPINNED) {
      issues.push({
        dependency: name,
        message: "version is UNPINNED — this is a required human input",
        fix: `ask the owning team for the exact ${name} version to pin, then set it in upstream.lock`,
        severity: "error",
      });
    } else if (/^(?:latest|main|master|head|\*)$/i.test(dependency.version)) {
      issues.push({
        dependency: name,
        message: `version "${dependency.version}" is a moving target`,
        fix: "pin an exact version or tag; the toolchain must not change without a commit",
        severity: "error",
      });
    } else if (/^[\^~]/.test(dependency.version)) {
      issues.push({
        dependency: name,
        message: `version "${dependency.version}" is a floating range`,
        fix: `pin the exact version, e.g. ${dependency.version.replace(/^[\^~]/, "")}`,
        severity: "error",
      });
    }

    // ---- the pin has to reach the install command ----
    // `claude plugin marketplace add obra/superpowers` tracks whatever the
    // default branch happens to be. The `version:` field above it then records
    // a number nothing enforces — a decorative pin, which is precisely the
    // failure "reject moving versions" exists to prevent, wearing a version
    // string as a disguise. A ref (`owner/repo#v6.2.0`) is what makes it real.
    const install = dependency.install;
    if (
      install !== undefined &&
      dependency.version !== UNPINNED &&
      PLUGIN_INSTALL.test(install) &&
      !mentionsVersion(install, dependency.version)
    ) {
      issues.push({
        dependency: name,
        message: `install command does not pin ${dependency.version} — \`${install}\` tracks the default branch, so the recorded version is decorative`,
        fix: `pin the ref in the command, e.g. \`${install.replace(/(\s)(\S+)$/, `$1$2#v${dependency.version.replace(/^v/, "")}`)}\``,
        severity: "error",
      });
    }

    // ---- mirroring ----
    // Only installed dependencies are mirrored; a pattern source is never fetched.
    if (dependency.role === "install" && dependency.mirror === undefined) {
      issues.push({
        dependency: name,
        message: "no internal mirror recorded",
        fix: "mirror the pinned version internally and record it as `mirror:`",
        severity: "warning",
      });
    }

    // ---- phase ownership ----
    if (dependency.role === "pattern-source" && dependency.owns.length > 0) {
      issues.push({
        dependency: name,
        message: `role is \`pattern-source\` but it claims ${dependency.owns.join(", ")}`,
        fix: "a pattern source is not installed and cannot own a phase — set `owns: []` or change the role",
        severity: "error",
      });
    }

    for (const phase of dependency.owns) {
      if (!isPhase(phase)) {
        issues.push({
          dependency: name,
          message: `unknown phase "${phase}"`,
          fix: `phases are: ${PHASES.join(", ")}`,
          severity: "error",
        });
        continue;
      }

      // The declared owner in the ownership map must agree.
      const declaredOwner = PHASE_OWNERS[phase];
      if (!declaredOwner.split("+").includes(name)) {
        issues.push({
          dependency: name,
          message: `claims phase \`${phase}\`, which the ownership map assigns to \`${declaredOwner}\``,
          fix: `one owner per phase — either correct \`owns\` for ${name}, or change PHASE_OWNERS if the design has genuinely moved`,
          severity: "error",
        });
      }

      const existing = claims.get(phase) ?? [];
      existing.push(name);
      claims.set(phase, existing);
    }
  }

  // ---- two dependencies claiming one phase ----
  for (const [phase, claimants] of claims) {
    if (claimants.length > 1) {
      issues.push({
        dependency: claimants.join(" + "),
        message: `phase \`${phase}\` is claimed by ${claimants.length} dependencies: ${claimants.join(", ")}`,
        fix: "one owner per phase — remove the claim from whichever should not own it",
        severity: "error",
      });
    }
  }

  return issues;
}

/** Dependencies Keel actually installs, as opposed to pattern sources. */
export function installable(lock: UpstreamLock): Array<[string, UpstreamDependency]> {
  return Object.entries(lock.dependencies).filter(([, d]) => d.role === "install");
}
