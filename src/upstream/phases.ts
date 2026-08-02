import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { isDirectory, isFile } from "../shared/paths.js";

/**
 * Phase ownership (build spec M2.3).
 *
 * Rule of the road 7: one owner per phase. Two skills that both want to own
 * planning is the failure mode that makes composed toolchains fight each other,
 * and it is invisible until output quality drops — so it is checked, loudly, at
 * `keel check` rather than discovered later.
 */

export const PHASES = [
  "classification",
  "design",
  "planning",
  "implementation",
  "verification",
  "spec-conformance",
  "review",
] as const;

export type Phase = (typeof PHASES)[number];

/** The declared owner of each phase. This table is the contract. */
export const PHASE_OWNERS: Readonly<Record<Phase, string>> = {
  classification: "keel",
  design: "openspec",
  planning: "superpowers",
  implementation: "superpowers",
  verification: "claude-code-builtins+keel-rubrics",
  "spec-conformance": "openspec+builtin-spec-validation",
  review: "managed-code-review+keel-rubric",
};

export interface PhaseClaim {
  /** Where the claim came from: a skill name or a plugin id. */
  readonly claimant: string;
  readonly phase: Phase;
  /** File the claim was found in, for the error message. */
  readonly source: string;
}

export interface PhaseConflict {
  readonly phase: Phase;
  readonly claimants: readonly PhaseClaim[];
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/**
 * Read `keel-phases:` claims out of a skill's frontmatter.
 *
 * A skill declares what it owns:
 *
 *     ---
 *     name: my-planner
 *     keel-phases: [planning]
 *     ---
 */
export function claimsInFrontmatter(text: string, source: string, fallbackName: string): PhaseClaim[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const frontmatter = parsed as Record<string, unknown>;
  const raw = frontmatter["keel-phases"] ?? frontmatter["keel_phases"];
  const name = typeof frontmatter["name"] === "string" ? frontmatter["name"] : fallbackName;

  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.filter(isPhase).map((phase) => ({ claimant: name, phase, source }));
}

/** Walk a skills directory collecting phase claims from every SKILL.md. */
export function collectClaims(skillsRoot: string): PhaseClaim[] {
  if (!isDirectory(skillsRoot)) return [];

  const claims: PhaseClaim[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return [];
  }

  for (const entry of entries.sort()) {
    const skillFile = join(skillsRoot, entry, "SKILL.md");
    if (!isFile(skillFile)) continue;
    try {
      claims.push(...claimsInFrontmatter(readFileSync(skillFile, "utf8"), skillFile, entry));
    } catch {
      continue;
    }
  }
  return claims;
}

/**
 * Find phases claimed by more than one distinct source.
 *
 * Two claims from the same claimant are fine — a single owner may declare a
 * phase in more than one place. Two *different* claimants are the conflict.
 */
export function findConflicts(claims: readonly PhaseClaim[]): PhaseConflict[] {
  const byPhase = new Map<Phase, PhaseClaim[]>();
  for (const claim of claims) {
    const list = byPhase.get(claim.phase) ?? [];
    list.push(claim);
    byPhase.set(claim.phase, list);
  }

  const conflicts: PhaseConflict[] = [];
  for (const [phase, list] of byPhase) {
    const distinct = new Set(list.map((c) => c.claimant));
    if (distinct.size > 1) conflicts.push({ phase, claimants: list });
  }

  return conflicts.sort((a, b) => a.phase.localeCompare(b.phase));
}

/**
 * Every distinct place a repo can carry skills that might claim a phase.
 *
 * De-duplicated, and that is not cosmetic. When the repository *is* the plugin
 * checkout — during development of Keel itself, and in any repo that vendors it
 * — `pluginRoot/skills` and `repoRoot/skills` are the same directory, so the
 * walk collected every claim twice. `keel check` reported "2 declared claims"
 * for one real claim, and a single skill would have been reported as conflicting
 * with itself had `findConflicts` not happened to compare claimant names.
 *
 * Paths are resolved before comparison so `/repo/skills` and `/repo/./skills`
 * count as one.
 */
export function skillRoots(repoRoot: string, pluginRoot: string): string[] {
  const candidates = [
    join(pluginRoot, "skills"),
    join(repoRoot, ".claude", "skills"),
    join(repoRoot, "skills"),
  ];
  return [...new Set(candidates.map((p) => resolve(p)))];
}

export interface PhaseAudit {
  readonly claims: readonly PhaseClaim[];
  readonly conflicts: readonly PhaseConflict[];
  /**
   * Skill directories that existed and were actually read.
   *
   * Reported so the result can be read honestly. This audit sees `keel-phases:`
   * frontmatter in SKILL.md files under these paths and nothing else —
   * Superpowers is installed into Claude Code's plugin cache outside any
   * checkout, and OpenSpec ships slash commands rather than skills. A clean
   * result means "nothing here conflicts", not "the installed toolchain was
   * verified", and a check that implies the second is a check that lies.
   */
  readonly roots: readonly string[];
}

export function auditPhases(repoRoot: string, pluginRoot: string): PhaseAudit {
  const roots = skillRoots(repoRoot, pluginRoot);
  const claims = roots.flatMap((root) => collectClaims(root));
  return { claims, conflicts: findConflicts(claims), roots: roots.filter(isDirectory) };
}
