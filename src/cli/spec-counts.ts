import type { DeltaKind, DeltaSection } from "../spec/delta.js";

/**
 * Counting *requirements* in a spec delta, not the headings above them.
 *
 * `renderDelta` summarises by counting sections, so a freshly scaffolded and
 * completely empty proposal — three bare `## ADDED|MODIFIED|REMOVED
 * Requirements` headings with nothing under them — rendered
 * `+ 1 added · ~ 1 modified · - 1 removed`. A reviewer reading that PR comment
 * is told three requirements changed when none has been written.
 *
 * `src/spec/delta.ts` exposes sections and their raw bodies and nothing finer,
 * so the requirement-level parse happens here, against the body text.
 *
 * What counts as one requirement, in order of preference:
 *   1. `### Requirement: <name>` — OpenSpec's own convention.
 *   2. Any deeper heading inside the section, when (1) finds none.
 *   3. Top-level list items, for proposals written as bullets.
 * An empty body counts zero, which is the whole point.
 */

const REQUIREMENT_HEADING = /^#{3,6}\s+Requirements?\s*:/i;
const ANY_HEADING = /^#{3,6}\s+\S/;
const TOP_LEVEL_BULLET = /^(?:[-*+]|\d+[.)])\s+\S/;

/** How many requirements one delta section actually carries. */
export function requirementsIn(section: DeltaSection): number {
  const lines = section.body.split("\n");

  let named = 0;
  let headings = 0;
  let bullets = 0;
  let inFence = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (REQUIREMENT_HEADING.test(line)) {
      named++;
      continue;
    }
    if (ANY_HEADING.test(line)) {
      headings++;
      continue;
    }
    // Only unindented bullets: nested ones are acceptance criteria, not
    // separate requirements.
    if (TOP_LEVEL_BULLET.test(raw)) bullets++;
  }

  if (named > 0) return named;
  if (headings > 0) return headings;
  return bullets;
}

export interface RequirementCounts {
  readonly byKind: ReadonlyMap<DeltaKind, number>;
  readonly total: number;
  /** Sections present but carrying no requirement at all. */
  readonly emptySections: number;
}

export function countRequirements(sections: readonly DeltaSection[]): RequirementCounts {
  const byKind = new Map<DeltaKind, number>();
  let total = 0;
  let emptySections = 0;

  for (const section of sections) {
    const n = requirementsIn(section);
    if (n === 0) emptySections++;
    if (n > 0) byKind.set(section.kind, (byKind.get(section.kind) ?? 0) + n);
    total += n;
  }

  return { byKind, total, emptySections };
}

const EMOJI: Readonly<Record<DeltaKind, string>> = {
  ADDED: "+",
  MODIFIED: "~",
  REMOVED: "-",
  RENAMED: "→",
};

/** `+ 3 added · ~ 1 modified`, or an explicit "no requirements yet". */
export function summariseRequirements(counts: RequirementCounts): string {
  if (counts.total === 0) {
    return counts.emptySections > 0
      ? `_No requirements yet_ — ${counts.emptySections} empty delta section${counts.emptySections === 1 ? "" : "s"}`
      : "_No requirements yet_";
  }
  return [...counts.byKind.entries()]
    .map(([kind, n]) => `${EMOJI[kind]} ${n} ${kind.toLowerCase()}`)
    .join(" · ");
}

/**
 * The summary line `renderDelta` produced, replaced with a requirement count.
 *
 * A wrapper rather than a fix in `src/spec/delta.ts` because that module renders
 * the whole document from the section list and exposes no seam for the summary.
 * The line it emits has a fixed shape — the first line after the `## Spec delta`
 * heading — so it is matched exactly and left alone if it ever changes.
 */
export function withRequirementCounts(rendered: string, sections: readonly DeltaSection[]): string {
  if (sections.length === 0) return rendered;

  const counts = countRequirements(sections);
  const replacement = summariseRequirements(counts);
  const lines = rendered.split("\n");
  const sectionSummary = /^[+~\-→] \d+ (?:added|modified|removed|renamed)(?: · [+~\-→] \d+ \w+)*$/;

  for (let i = 0; i < lines.length; i++) {
    if (sectionSummary.test(lines[i] ?? "")) {
      lines[i] = replacement;
      return lines.join("\n");
    }
  }
  return rendered;
}
