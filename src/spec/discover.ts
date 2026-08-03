import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parse as parseYaml } from "yaml";

import { DEFAULT_SPEC_DIR, type KeelConfig } from "../shared/config.js";
import { logWarn } from "../shared/log.js";
import { escapesRepo, isDirectory, isFile, resolveConfiguredPath } from "../shared/paths.js";

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

/**
 * The OpenSpec working tree.
 *
 * `spec.dir` is a configured path, so it is contained rather than trusted:
 * `../../../../openspec` and `/tmp/openspec` both used to resolve straight
 * through, reading proposals from — and scaffolding changes into — a directory
 * outside the repository. An escaping value is logged and replaced with the
 * documented default, so `keel spec` keeps working on the right tree.
 */
export function specRoot(root: string, config: KeelConfig): string {
  const resolved = resolveConfiguredPath(root, config.spec.dir, {
    key: "spec.dir",
    fallback: DEFAULT_SPEC_DIR,
  });
  if (!resolved.ok) logWarn(resolved.error ?? "spec.dir is not inside the repository");
  return resolved.path;
}

export function changesDir(root: string, config: KeelConfig): string {
  return join(specRoot(root, config), "changes");
}

/**
 * Depth cap for the spec tree. OpenSpec's deepest documented layout is
 * `changes/<id>/specs/<capability>/spec.md` — three levels below the change.
 * Sixteen leaves room for conventions we have not seen without ever letting the
 * walk run away.
 */
const MAX_SPEC_DEPTH = 16;

/** `dev:ino` for a directory, or null when it cannot be identified. */
function directoryId(dir: string): string | null {
  try {
    const s = statSync(dir);
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

/**
 * Every markdown file belonging to one change.
 *
 * The walk is bounded three ways, because it feeds the `spec.max_lines` cap and
 * an inflated count either fails an honest change or passes a bloated one. A
 * self-referential directory symlink used to recurse until the kernel returned
 * `ELOOP` at ~40 levels, counting a 4-line proposal as 164 lines:
 *
 *  - a visited set keyed on `dev:ino`, so a cycle is entered exactly once;
 *  - a depth cap, which also catches a cycle the inode check cannot see;
 *  - containment, so a symlink out of the spec tree is not followed at all —
 *    neither into a directory nor onto a file whose contents would then be read
 *    back out by `keel spec delta`.
 */
function markdownFiles(dir: string, boundary: string): string[] {
  const out: string[] = [];
  walkMarkdown(dir, boundary, out, new Set<string>(), 0);
  return out;
}

function walkMarkdown(
  dir: string,
  boundary: string,
  out: string[],
  visited: Set<string>,
  depth: number,
): void {
  if (depth > MAX_SPEC_DEPTH) {
    logWarn("spec tree deeper than the walk limit; stopping", { depth: MAX_SPEC_DEPTH });
    return;
  }

  const id = directoryId(dir);
  if (id !== null) {
    if (visited.has(id)) return;
    visited.add(id);
  }

  let entries: Dirent[];
  try {
    // `withFileTypes` reports the entry itself, so a symlink is visible as one
    // rather than as whatever it resolves to.
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);

    // A link is followed only if it stays in the spec tree. `escapesRepo`
    // resolves it, so this covers a chain of links as well as a single one.
    if (entry.isSymbolicLink() && escapesRepo(boundary, path)) {
      logWarn("spec tree contains a symlink out of the tree; skipping", { name: entry.name });
      continue;
    }

    if (isDirectory(path)) {
      // `archive/` is a sibling namespace, never part of another change.
      if (entry.name === "archive") continue;
      walkMarkdown(path, boundary, out, visited, depth + 1);
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      out.push(path);
    }
  }
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

function readProposal(root: string, dir: string, archived: boolean, boundary: string): Proposal {
  const files = markdownFiles(dir, boundary);
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
  // The spec tree is the containment boundary for the walk below: a change may
  // link to a sibling change, but nothing in it may reach outside the tree.
  const boundary = specRoot(root, config);
  const changes = join(boundary, "changes");
  if (!isDirectory(changes)) return [];

  const out: Proposal[] = [];

  for (const entry of readdirSync(changes).sort()) {
    const path = join(changes, entry);
    if (!isDirectory(path)) continue;
    if (entry === "archive") continue;
    out.push(readProposal(root, path, false, boundary));
  }

  const archive = join(changes, "archive");
  if (isDirectory(archive)) {
    for (const entry of readdirSync(archive).sort()) {
      const path = join(archive, entry);
      if (!isDirectory(path)) continue;
      out.push(readProposal(root, path, true, boundary));
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
