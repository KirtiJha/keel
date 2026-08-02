import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KeelConfig } from "../shared/config.js";
import { isFile } from "../shared/paths.js";

import { detectCommands, detectPurpose } from "./commands.js";
import type { GotchaCandidate } from "./gotchas.js";

/**
 * CLAUDE.md generation.
 *
 * Two rules shape everything here:
 *
 *   1. Under 60 lines (M5). A long CLAUDE.md is read the way a long README is
 *      read, which is to say skimmed and then ignored.
 *   2. No facts already visible in a config file. The model can open
 *      package.json; it cannot guess that this repo's tests are run through
 *      `make test` rather than `npm test`.
 *
 * `keel init` is idempotent and only ever rewrites between the managed markers,
 * so anything a human adds outside them survives (M9.5).
 */

export const BEGIN_MARKER = "<!-- keel:begin -->";
export const END_MARKER = "<!-- keel:end -->";
export const MAX_MANAGED_LINES = 60;

const COMMAND_LABELS: ReadonlyArray<readonly [keyof ReturnType<typeof detectCommands>, string]> = [
  ["install", "install"],
  ["build", "build"],
  ["test", "test"],
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["run", "run locally"],
];

export interface GenerateOptions {
  readonly root: string;
  readonly config: KeelConfig;
  /** Only candidates a human confirmed. The scanner's raw output never lands here. */
  readonly confirmedGotchas: readonly GotchaCandidate[];
  /** Names of active guide-mode packs, listed as pointers rather than content. */
  readonly guidePacks?: readonly string[];
}

/** Build the managed block. Deterministic for a given repo state. */
export function generateManagedBlock(options: GenerateOptions): string {
  const { root, config } = options;
  const lines: string[] = [BEGIN_MARKER];

  lines.push(`# ${config.repo.name}`);
  lines.push("");

  const purpose = detectPurpose(root);
  if (purpose !== null) {
    lines.push(purpose);
    lines.push("");
  }

  const commands = detectCommands(root);
  const present = COMMAND_LABELS.filter(([key]) => commands[key] !== undefined);
  if (present.length > 0) {
    lines.push("## Commands");
    lines.push("");
    for (const [key, label] of present) {
      lines.push(`- ${label}: \`${commands[key] ?? ""}\``);
    }
    lines.push("");
  }

  if (options.confirmedGotchas.length > 0) {
    lines.push("## Gotchas");
    lines.push("");
    // Budget the section so one noisy repo cannot blow the 60-line cap.
    const room = Math.max(0, MAX_MANAGED_LINES - lines.length - 8);
    for (const gotcha of options.confirmedGotchas.slice(0, room)) {
      lines.push(`- ${gotcha.proposed}`);
    }
    lines.push("");
  }

  lines.push("## Process");
  lines.push("");
  // Not "chosen automatically" — nothing invokes the router. SessionStart
  // injects a reminder and this line is the other half of that nudge; the
  // classification is deterministic, but running it is the model's choice and
  // CI is where the process gates actually bite.
  lines.push(
    "- Run `keel route` to see which track this change is on. Quick changes need " +
      "no plan; standard and full do.",
  );
  if (config.tdd.enabled) {
    lines.push("- Tests first. The RED run must actually happen — gates check that it did.");
  }
  const guides = options.guidePacks ?? [];
  if (guides.length > 0) {
    lines.push(`- Standards guidance loads on matching paths: ${guides.join(", ")}.`);
  }
  lines.push("- `keel doctor` lists active packs, gate timings and config problems.");

  lines.push(END_MARKER);
  return lines.join("\n");
}

/** Managed content clipped to the line cap, so the guarantee is structural. */
export function generateManagedBlockCapped(options: GenerateOptions): string {
  const block = generateManagedBlock(options);
  const lines = block.split("\n");
  if (lines.length <= MAX_MANAGED_LINES) return block;

  // Preserve the end marker; drop from the middle of the last open section.
  const kept = lines.slice(0, MAX_MANAGED_LINES - 1);
  kept.push(END_MARKER);
  return kept.join("\n");
}

export interface MergeResult {
  readonly content: string;
  readonly action: "created" | "updated" | "appended" | "unchanged";
}

/**
 * Splice the managed block into existing content without touching anything
 * outside the markers.
 */
export function mergeClaudeMd(existing: string | null, managed: string): MergeResult {
  if (existing === null || existing.trim() === "") {
    return { content: `${managed}\n`, action: "created" };
  }

  const start = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);

  if (start >= 0 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END_MARKER.length);
    const merged = `${before}${managed}${after}`;
    return {
      content: merged,
      action: merged === existing ? "unchanged" : "updated",
    };
  }

  // No markers: keep every existing byte and append the managed block.
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${existing}${separator}${managed}\n`, action: "appended" };
}

export function claudeMdPath(root: string): string {
  return join(root, "CLAUDE.md");
}

export function readClaudeMd(root: string): string | null {
  const path = claudeMdPath(root);
  if (!isFile(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Write CLAUDE.md, preserving hand-edited content outside the markers. */
export function writeClaudeMd(options: GenerateOptions): MergeResult {
  const managed = generateManagedBlockCapped(options);
  const result = mergeClaudeMd(readClaudeMd(options.root), managed);
  if (result.action !== "unchanged") {
    writeFileSync(claudeMdPath(options.root), result.content, "utf8");
  }
  return result;
}
