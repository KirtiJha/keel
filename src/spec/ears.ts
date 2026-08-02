import { readFileSync } from "node:fs";
import { relative } from "node:path";

import type { Proposal } from "./discover.js";
import type { SpecIssue } from "./check.js";

/**
 * EARS acceptance criteria — optional, off by default.
 *
 * The plan is deliberately non-committal: "Optional: EARS acceptance criteria
 * on Full-track changes only. Each line maps cleanly to one test... Try it on
 * two changes before deciding."
 *
 * So this ships switched off (`spec.ears: false`) and validates rather than
 * requires: turn it on for a couple of changes, see whether the criteria
 * actually map to tests, and decide. Enabling it is one config line; nobody has
 * to adopt a notation on the strength of a maybe.
 *
 * Recognised patterns (Easy Approach to Requirements Syntax):
 *
 *   ubiquitous   THE SYSTEM SHALL <response>
 *   event        WHEN <trigger> THE SYSTEM SHALL <response>
 *   state        WHILE <state> THE SYSTEM SHALL <response>
 *   unwanted     IF <condition> THEN THE SYSTEM SHALL <response>
 *   optional     WHERE <feature> THE SYSTEM SHALL <response>
 */

const PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: "event", re: /^\s*WHEN\s+.+\s+THE\s+SYSTEM\s+SHALL\s+.+/i },
  { name: "unwanted", re: /^\s*IF\s+.+\s+THEN\s+THE\s+SYSTEM\s+SHALL\s+.+/i },
  { name: "state", re: /^\s*WHILE\s+.+\s+THE\s+SYSTEM\s+SHALL\s+.+/i },
  { name: "optional", re: /^\s*WHERE\s+.+\s+THE\s+SYSTEM\s+SHALL\s+.+/i },
  { name: "ubiquitous", re: /^\s*THE\s+SYSTEM\s+SHALL\s+.+/i },
];

/** Headings under which lines are treated as acceptance criteria. */
const CRITERIA_HEADING = /^#{2,6}\s+(acceptance\s+criteria|criteria|requirements?)\b/i;

export function isEars(line: string): boolean {
  const stripped = line.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "").trim();
  if (stripped === "") return false;
  return PATTERNS.some((p) => p.re.test(stripped));
}

export function earsPattern(line: string): string | null {
  const stripped = line.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "").trim();
  return PATTERNS.find((p) => p.re.test(stripped))?.name ?? null;
}

/** Bullet lines under an acceptance-criteria heading. */
function criteriaLines(markdown: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = markdown.split("\n");
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (CRITERIA_HEADING.test(raw)) {
      inSection = true;
      continue;
    }
    if (/^#{1,6}\s+/.test(raw)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    const bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(raw);
    if (bullet !== null && (bullet[1] ?? "").trim() !== "") {
      out.push({ line: i + 1, text: bullet[1] ?? "" });
    }
  }

  return out;
}

/**
 * Report criteria that are not in EARS form. Warnings only, never errors —
 * this is a notation being trialled, not a rule that has earned a block.
 */
export function validateEars(root: string, proposals: readonly Proposal[]): SpecIssue[] {
  const issues: SpecIssue[] = [];

  for (const proposal of proposals) {
    for (const path of proposal.files) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }

      const rel = relative(root, path).split(/[\\/]/).join("/");
      for (const { line, text: criterion } of criteriaLines(text)) {
        if (isEars(criterion)) continue;
        issues.push({
          rule: "ears",
          change: proposal.id,
          message: `${rel}:${line} is not in EARS form: "${criterion.slice(0, 80)}"`,
          fix: 'use `WHEN <trigger> THE SYSTEM SHALL <response>` (or IF/WHILE/WHERE, or a bare `THE SYSTEM SHALL ...`) so each line maps to one test. Set `spec.ears: false` to stop checking.',
          severity: "warning",
        });
      }
    }
  }

  return issues;
}
