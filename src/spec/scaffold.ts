import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { KeelConfig } from "../shared/config.js";
import { exec } from "../shared/exec.js";
import { isDirectory } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import { changesDir, specRoot } from "./discover.js";

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
 * Brownfield bootstrap belongs to OpenSpec, and Keel only checks that OpenSpec
 * is installed before handing over — reimplementing it would put two owners on
 * the design phase.
 *
 * What it is *not*: `/opsx:onboard` does not read a legacy service and emit
 * specs describing it. OpenSpec's own docs describe a guided walkthrough that
 * produces one small real change, and it ships nothing that generates specs
 * from existing code. It is also expanded-profile only, so on a default install
 * the command is absent entirely. Saying otherwise sent people looking for a
 * feature that does not exist.
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

  // The *contained* spec root, not the raw config value: telling someone to
  // commit under a directory Keel has rejected is worse than saying nothing.
  const dir = relative(root, specRoot(root, config)).split(/[\\/]/).join("/");

  lines.push("There is no command that reads this codebase and writes specs for it.");
  lines.push("OpenSpec does not ship one, and neither does Keel. A legacy repo");
  lines.push("accretes specs one change at a time:");
  lines.push("");
  lines.push("  1. Take the next real change you were going to make anyway.");
  lines.push("  2. `keel spec new <id>` scaffolds the proposal; describe only what");
  lines.push("     that change alters, not the system around it.");
  lines.push("  3. Build it, then archive — the delta folds into `" + dir + "/specs/`.");
  lines.push("");
  lines.push("After a few changes the specs cover the parts under active development,");
  lines.push("which are the parts worth specifying. The rest stays undocumented, and");
  lines.push("that is the correct trade: a spec nobody derived from real work is a");
  lines.push("guess, and a wrong spec is worse than none.");
  lines.push("");
  lines.push("`/opsx:onboard` is a guided walkthrough of that loop on one small change.");
  lines.push("It is expanded-profile only — `openspec config profile` if it is missing.");

  return lines;
}
