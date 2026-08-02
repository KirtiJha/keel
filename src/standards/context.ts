import { readFileSync } from "node:fs";

import type { KeelConfig } from "../shared/config.js";
import { toRepoRelative } from "../shared/paths.js";

import { type LoadedPack, loadPacks } from "./loader.js";
import { applicablePacks } from "./runner.js";

/**
 * Guide and review modes — the two pack modes that produce text rather than a
 * verdict.
 *
 * Guide mode suggests, never forces. Conflicting instructions measurably
 * degrade model output, so the wording here is advisory and the hook attaches
 * it as `additionalContext` rather than as a permission decision.
 */

export interface GuideSuggestion {
  readonly pack: string;
  readonly description: string;
  readonly owner: string;
  readonly body: string;
}

function readOrNull(path: string | null): string | null {
  if (path === null) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Guide packs whose `applies_to` matches the file about to be written. */
export function guidesFor(
  repoRoot: string,
  pluginRoot: string,
  config: KeelConfig,
  filePath: string,
): GuideSuggestion[] {
  const repoRel = toRepoRelative(repoRoot, filePath);
  const { packs } = loadPacks(repoRoot, pluginRoot, config);

  const out: GuideSuggestion[] = [];
  for (const pack of applicablePacks(packs, repoRel, "guide")) {
    const body = readOrNull(pack.guidePath);
    if (body === null) continue;
    out.push({
      pack: pack.standard.name,
      description: pack.standard.description,
      owner: pack.standard.owner,
      body: body.trim(),
    });
  }
  return out;
}

/**
 * Render guides as additionalContext.
 *
 * `alreadyLoaded` de-duplicates against guides surfaced earlier in the session:
 * repeating the same standard on every edit to the same area is noise, and
 * noise is what gets a gate switched off.
 */
export function renderGuides(
  guides: readonly GuideSuggestion[],
  alreadyLoaded: ReadonlySet<string>,
): string | null {
  const fresh = guides.filter((g) => !alreadyLoaded.has(g.pack));
  if (fresh.length === 0) return null;

  const parts = ["Keel standards that apply to this file (guidance, not a gate):", ""];
  for (const guide of fresh) {
    parts.push(`## ${guide.pack} — ${guide.description} (owner: ${guide.owner})`);
    parts.push(guide.body);
    parts.push("");
  }
  return parts.join("\n").trim();
}

export interface RubricEntry {
  readonly pack: string;
  readonly description: string;
  readonly body: string;
  /** Which of the touched paths this rubric was selected for. */
  readonly paths: readonly string[];
}

/**
 * Rubric entries for the review chain, filtered by the paths actually touched.
 *
 * Filtering matters: a review prompt carrying every rubric the org owns is a
 * prompt the model skims. Only standards that could apply to this diff appear.
 */
export function rubricsFor(
  repoRoot: string,
  pluginRoot: string,
  config: KeelConfig,
  changedPaths: readonly string[],
): RubricEntry[] {
  const { packs } = loadPacks(repoRoot, pluginRoot, config);
  const matched = new Map<string, { pack: LoadedPack; paths: string[] }>();

  for (const path of changedPaths) {
    const repoRel = toRepoRelative(repoRoot, path);
    for (const pack of applicablePacks(packs, repoRel, "review")) {
      const entry = matched.get(pack.standard.name) ?? { pack, paths: [] };
      entry.paths.push(repoRel);
      matched.set(pack.standard.name, entry);
    }
  }

  const out: RubricEntry[] = [];
  for (const { pack, paths } of matched.values()) {
    const body = readOrNull(pack.rubricPath);
    if (body === null) continue;
    out.push({
      pack: pack.standard.name,
      description: pack.standard.description,
      body: body.trim(),
      paths,
    });
  }
  return out.sort((a, b) => a.pack.localeCompare(b.pack));
}

/** Concatenate rubric entries into review-chain input. */
export function renderRubrics(entries: readonly RubricEntry[]): string {
  if (entries.length === 0) return "";
  const parts = ["# Keel review rubric", "", "Applies to the paths this change touches.", ""];
  for (const entry of entries) {
    parts.push(`## ${entry.pack} — ${entry.description}`);
    parts.push(`Touched: ${entry.paths.slice(0, 5).join(", ")}`);
    parts.push("");
    parts.push(entry.body);
    parts.push("");
  }
  return parts.join("\n").trim();
}
