import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { parse as parseYaml } from "yaml";

import type { KeelConfig } from "../shared/config.js";
import { isDirectory, isFile } from "../shared/paths.js";

/**
 * Finding OpenSpec change proposals.
 *
 * Keel does not author spec content and does not reimplement OpenSpec — rule 7
 * gives OpenSpec the design phase. What Keel owns is the *discipline* around
 * specs: are they small, is the delta attached to the PR, was the change
 * archived at merge. All of that needs is to find the files and read their
 * shape, which is what this module does.
 *
 * Layout follows OpenSpec's convention:
 *
 *   <spec.dir>/
 *     specs/<capability>/spec.md          capability specs
 *     changes/<change-id>/proposal.md     the proposal
 *     changes/<change-id>/specs/**        the delta
 *     changes/archive/<change-id>/        archived after merge
 */

export type ProposalStatus = "draft" | "in-progress" | "applied" | "archived" | "unknown";

export interface Proposal {
  /** Change id — the directory name. */
  readonly id: string;
  /** Absolute path of the change directory. */
  readonly dir: string;
  /** Repo-relative, POSIX. */
  readonly relDir: string;
  readonly status: ProposalStatus;
  readonly archived: boolean;
  /** Every markdown file belonging to this change. */
  readonly files: readonly string[];
  /** Total markdown lines across the change — what the size cap measures. */
  readonly lineCount: number;
}

export function changesDir(root: string, config: KeelConfig): string {
  return join(root, config.spec.dir, "changes");
}

export function archiveDir(root: string, config: KeelConfig): string {
  return join(changesDir(root, config), "archive");
}

function markdownFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    if (isDirectory(path)) {
      // `archive/` is a sibling namespace, never part of another change.
      if (entry === "archive") continue;
      markdownFiles(path, out);
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

function countLines(paths: readonly string[]): number {
  let total = 0;
  for (const path of paths) {
    try {
      const text = readFileSync(path, "utf8");
      if (text.trim() === "") continue;
      total += text.replace(/\n$/, "").split("\n").length;
    } catch {
      continue;
    }
  }
  return total;
}

/**
 * Status from the proposal's frontmatter, falling back to its location.
 *
 * Location is authoritative for `archived`: a file under `archive/` is archived
 * whatever its frontmatter claims, because moving it there is the act of
 * archiving.
 */
function readStatus(proposalPath: string): ProposalStatus {
  if (!isFile(proposalPath)) return "unknown";
  let text: string;
  try {
    text = readFileSync(proposalPath, "utf8");
  } catch {
    return "unknown";
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match !== null) {
    try {
      const frontmatter: unknown = parseYaml(match[1] ?? "");
      if (typeof frontmatter === "object" && frontmatter !== null) {
        const status = (frontmatter as Record<string, unknown>)["status"];
        if (
          status === "draft" ||
          status === "in-progress" ||
          status === "applied" ||
          status === "archived"
        ) {
          return status;
        }
      }
    } catch {
      // Fall through: unreadable frontmatter is not a status.
    }
  }

  // A checked-off task list is the other common signal that work is done.
  if (/^\s*-\s*\[x\]/im.test(text) && !/^\s*-\s*\[ \]/im.test(text)) return "applied";
  return "unknown";
}

function readProposal(root: string, dir: string, archived: boolean): Proposal {
  const files = markdownFiles(dir);
  const proposalPath = join(dir, "proposal.md");
  const status = archived ? "archived" : readStatus(proposalPath);

  return {
    id: dir.split(/[\\/]/).pop() ?? "",
    dir,
    relDir: relative(root, dir).split(/[\\/]/).join("/"),
    status,
    archived,
    files,
    lineCount: countLines(files),
  };
}

/** Every change proposal in the repo, archived and not. */
export function discoverProposals(root: string, config: KeelConfig): Proposal[] {
  const changes = changesDir(root, config);
  if (!isDirectory(changes)) return [];

  const out: Proposal[] = [];

  for (const entry of readdirSync(changes).sort()) {
    const path = join(changes, entry);
    if (!isDirectory(path)) continue;
    if (entry === "archive") continue;
    out.push(readProposal(root, path, false));
  }

  const archive = archiveDir(root, config);
  if (isDirectory(archive)) {
    for (const entry of readdirSync(archive).sort()) {
      const path = join(archive, entry);
      if (!isDirectory(path)) continue;
      out.push(readProposal(root, path, true));
    }
  }

  return out;
}

/** Proposals not yet archived. */
export function activeProposals(root: string, config: KeelConfig): Proposal[] {
  return discoverProposals(root, config).filter((p) => !p.archived);
}

/**
 * The proposal a branch is working on.
 *
 * Matched by branch-name containment in both directions, which covers the two
 * conventions teams actually use: a branch named after the change
 * (`feat/add-webhooks` for change `add-webhooks`), and a change named after the
 * branch. Returns null when exactly one match cannot be identified.
 */
export function proposalForBranch(
  root: string,
  config: KeelConfig,
  branch: string,
): Proposal | null {
  const active = activeProposals(root, config);
  if (active.length === 0) return null;

  const normalised = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const matches = active.filter((p) => {
    const id = p.id.toLowerCase();
    return normalised.includes(id) || id.includes(normalised);
  });

  if (matches.length === 1) return matches[0] ?? null;
  // Exactly one active proposal and no name match is still unambiguous.
  if (matches.length === 0 && active.length === 1) return active[0] ?? null;
  return null;
}
