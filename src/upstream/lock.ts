import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { isFile } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

/**
 * `upstream.lock` — pinned versions of the upstream toolchains Keel composes.
 *
 * Rule of the road 6: compose, don't fork. Pin, mirror, never patch.
 *
 * The concrete versions are a **blocked input** (build spec §1): the spec says
 * to ask for them and explicitly forbids resolving `latest`. So this module
 * implements the format, the validation and the "unpinned" state as real
 * behaviour — `keel check` reports an unpinned entry as an error naming what to
 * do — rather than inventing version numbers that would look authoritative and
 * be wrong.
 */

export const UNPINNED = "UNPINNED" as const;

const DependencySchema = z
  .object({
    /** Semver, a git tag, or the literal `UNPINNED` until a human supplies one. */
    version: z.string().min(1),
    source: z.string().min(1),
    /** Internal mirror, per "pin upstream versions, mirror internally". */
    mirror: z.string().optional(),
    /** Which phases this dependency owns; cross-checked against PHASE_OWNERS. */
    owns: z.array(z.string()).default([]),
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

/**
 * Validate pins.
 *
 * `latest` and floating ranges are errors, not warnings: an unpinned upstream
 * means the toolchain can change under a team without a commit, which is the
 * exact failure "compose, don't fork" exists to prevent.
 */
export function validateLock(lock: UpstreamLock): LockIssue[] {
  const issues: LockIssue[] = [];

  for (const [name, dependency] of Object.entries(lock.dependencies)) {
    if (dependency.version === UNPINNED) {
      issues.push({
        dependency: name,
        message: "version is UNPINNED — this is a required human input",
        fix: `ask the owning team for the exact ${name} version to pin, then set it in upstream.lock`,
        severity: "error",
      });
      continue;
    }

    if (/^(?:latest|main|master|head|\*)$/i.test(dependency.version)) {
      issues.push({
        dependency: name,
        message: `version "${dependency.version}" is a moving target`,
        fix: "pin an exact version or tag; the toolchain must not change without a commit",
        severity: "error",
      });
      continue;
    }

    if (/^[\^~]/.test(dependency.version)) {
      issues.push({
        dependency: name,
        message: `version "${dependency.version}" is a floating range`,
        fix: `pin the exact version, e.g. ${dependency.version.replace(/^[\^~]/, "")}`,
        severity: "error",
      });
    }

    if (dependency.mirror === undefined) {
      issues.push({
        dependency: name,
        message: "no internal mirror recorded",
        fix: "mirror the pinned version internally and record it as `mirror:`",
        severity: "warning",
      });
    }
  }

  return issues;
}

export function isFullyPinned(lock: UpstreamLock): boolean {
  return validateLock(lock).every((i) => i.severity !== "error");
}
