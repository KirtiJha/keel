import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { KeelConfig } from "../shared/config.js";
import { exec } from "../shared/exec.js";
import { isDirectory } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import { changesDir } from "./discover.js";

/**
 * Scaffolding a change.
 *
 * Rule 7 gives OpenSpec the design phase, so Keel creates *structure* and never
 * content: frontmatter, section headings, and the delta markers `keel spec
 * delta` reads. What goes under those headings is OpenSpec's job and the
 * author's — filler prose here would be inventing spec content, and would be
 * the first thing anyone deleted.
 */

export function isValidChangeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(id);
}

/** Is the OpenSpec CLI available on PATH? */
export function openspecAvailable(root: string): boolean {
  const res = exec("npx", ["--no-install", "openspec", "--version"], {
    cwd: root,
    timeoutMs: 20_000,
  });
  return res.ok && res.value.code === 0;
}

const PROPOSAL_TEMPLATE = [
  "---",
  "status: draft",
  "---",
  "",
  "# {id}",
  "",
  "## Why",
  "",
  "## What changes",
  "",
  "## ADDED Requirements",
  "",
  "## MODIFIED Requirements",
  "",
  "## REMOVED Requirements",
  "",
].join("\n");

export interface ScaffoldResult {
  readonly dir: string;
  readonly created: readonly string[];
  /** True when the OpenSpec CLI is installed and should drive from here. */
  readonly openspec: boolean;
}

export function scaffoldChange(
  root: string,
  config: KeelConfig,
  id: string,
): Result<ScaffoldResult, string> {
  if (!isValidChangeId(id)) {
    return err(
      `"${id}" is not a valid change id — use lower-case kebab-case, e.g. \`add-webhook-retries\``,
    );
  }

  const dir = join(changesDir(root, config), id);
  if (isDirectory(dir)) return err(`${dir} already exists`);

  try {
    mkdirSync(join(dir, "specs"), { recursive: true });
    const proposal = join(dir, "proposal.md");
    writeFileSync(proposal, PROPOSAL_TEMPLATE.replace("{id}", id), "utf8");

    return ok({
      dir,
      created: [proposal, join(dir, "specs")],
      openspec: openspecAvailable(root),
    });
  } catch (cause) {
    return err(errorMessage(cause));
  }
}

/**
 * Brownfield bootstrap (plan rule 1).
 *
 * `/opsx:onboard` is OpenSpec's command and extracting specs from existing code
 * is its job — reimplementing it would put two owners on the design phase. Keel
 * checks that OpenSpec is installed and hands over.
 */
export function onboardInstructions(root: string, config: KeelConfig): string[] {
  const available = openspecAvailable(root);
  const lines: string[] = [];

  if (!available) {
    lines.push("OpenSpec is not installed in this repository.");
    lines.push("");
    lines.push("  npm install --save-exact @fission-ai/openspec@1.7.0");
    lines.push("");
  }

  lines.push("Brownfield bootstrap is OpenSpec's `/opsx:onboard`, run once per repo:");
  lines.push("");
  lines.push("  1. Run `/opsx:onboard` in Claude Code and point it at the service.");
  lines.push("  2. Review every generated spec by hand before committing it.");
  lines.push("  3. Commit the result under `" + config.spec.dir + "/specs/`.");
  lines.push("");
  lines.push("Do not hand-write specs for existing behaviour, and do not let the");
  lines.push("generated output land unreviewed — a wrong spec is worse than none.");

  return lines;
}
