import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { exec } from "../shared/exec.js";
import { recentCommits } from "../shared/git.js";
import { isKeelInternalPath } from "../shared/paths.js";

/**
 * Gotcha scanner.
 *
 * Proposes candidates from git history and code shape. It never writes one:
 * M5 requires human confirmation for every entry, because an unreviewed gotcha
 * is worse than no gotcha — it is a confident, permanent, wrong instruction
 * sitting in the file the model trusts most.
 */

export type GotchaKind =
  | "hotfix-churn"
  | "warning-comment"
  | "non-static-entry"
  | "anomalous-coupling";

export interface GotchaCandidate {
  readonly kind: GotchaKind;
  readonly path: string;
  readonly line?: number;
  /** What was observed, shown to the human deciding. */
  readonly evidence: string;
  /** The line that would be written to CLAUDE.md if confirmed. */
  readonly proposed: string;
  readonly confidence: "high" | "medium" | "low";
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py",
]);

const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env"]);

/** Commit subjects that mean "this went wrong in production". */
const TROUBLE_SUBJECT = /\b(revert|reverts|reverted|hotfix|rollback|emergency|urgent|regression)\b/i;

/**
 * Comment markers that signal hard-won knowledge.
 *
 * Deliberately narrow. "why" alone matches half of all prose, so it is only
 * counted when it opens a comment as an explanation ("why: ...", "why we ...").
 */
const WARNING_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /\bhack\b/i, label: "marked as a hack" },
  { re: /\b(?:don't|do not|never)\s+(?:remove|delete|change|touch|reorder|rename)\b/i, label: "explicit do-not instruction" },
  { re: /\bcareful\b/i, label: "flagged as needing care" },
  { re: /\bgotcha\b/i, label: "self-described gotcha" },
  { re: /\bload[- ]bearing\b/i, label: "described as load-bearing" },
  { re: /^\s*why[:\s]/i, label: "explains a non-obvious why" },
  { re: /\b(?:looks|seems)\s+(?:dead|unused)\b/i, label: "warns it looks unused" },
];

function listFiles(root: string): string[] {
  const res = exec("git", ["ls-files"], { cwd: root, timeoutMs: 15_000 });
  if (!res.ok || res.value.code !== 0) return [];
  return res.value.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !isKeelInternalPath(l));
}

function readFile(root: string, relPath: string): string | null {
  try {
    const text = readFileSync(join(root, relPath), "utf8");
    // Skip anything implausibly large; it is generated, not written.
    return text.length > 512_000 ? null : text;
  } catch {
    return null;
  }
}

/** Comment bodies with their 1-based line numbers. */
function commentLines(text: string, isPython: boolean): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const lines = text.split("\n");
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    if (isPython) {
      const hash = raw.indexOf("#");
      if (hash >= 0) out.push({ line: i + 1, body: raw.slice(hash + 1).trim() });
      continue;
    }

    let body = "";
    if (inBlock) {
      const end = raw.indexOf("*/");
      body = end >= 0 ? raw.slice(0, end) : raw;
      if (end >= 0) inBlock = false;
    } else {
      const blockStart = raw.indexOf("/*");
      const lineStart = raw.indexOf("//");
      if (blockStart >= 0 && (lineStart < 0 || blockStart < lineStart)) {
        const end = raw.indexOf("*/", blockStart + 2);
        body = end >= 0 ? raw.slice(blockStart + 2, end) : raw.slice(blockStart + 2);
        if (end < 0) inBlock = true;
      } else if (lineStart >= 0) {
        body = raw.slice(lineStart + 2);
      }
    }

    const cleaned = body.replace(/^\s*\*+/, "").trim();
    if (cleaned !== "") out.push({ line: i + 1, body: cleaned });
  }
  return out;
}

/** Static import specifiers in a source file. */
function staticImports(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bimport\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/gm,
    /^\s*import\s+([A-Za-z_][\w.]*)/gm,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      if (match[1] !== undefined) out.push(match[1]);
      match = re.exec(text);
    }
  }
  return out;
}

function moduleStem(path: string): string {
  return basename(path, extname(path));
}

export interface ScanOptions {
  /** Commits to inspect for churn. */
  readonly historyLimit?: number;
  /** Cap on returned candidates, highest confidence first. */
  readonly max?: number;
}

/**
 * Propose gotcha candidates. Pure analysis — writes nothing.
 */
export function scanGotchas(root: string, options: ScanOptions = {}): GotchaCandidate[] {
  const files = listFiles(root);
  const sourceFiles = files.filter((f) => SOURCE_EXTENSIONS.has(extname(f)));
  const configFiles = files.filter((f) => CONFIG_EXTENSIONS.has(extname(f)));

  const candidates: GotchaCandidate[] = [];

  // ---- 1. Files with repeated revert/hotfix history -------------------------
  const troubleCounts = new Map<string, string[]>();
  for (const commit of recentCommits(root, options.historyLimit ?? 500)) {
    if (!TROUBLE_SUBJECT.test(commit.subject)) continue;
    for (const file of commit.files) {
      if (!SOURCE_EXTENSIONS.has(extname(file))) continue;
      const list = troubleCounts.get(file) ?? [];
      list.push(commit.subject);
      troubleCounts.set(file, list);
    }
  }
  for (const [path, subjects] of troubleCounts) {
    if (subjects.length < 2) continue;
    candidates.push({
      kind: "hotfix-churn",
      path,
      evidence: `${subjects.length} revert/hotfix commits touch this file, e.g. "${subjects[0] ?? ""}"`,
      proposed: `\`${path}\` has a history of hotfixes and reverts — change it carefully and check the git log first.`,
      confidence: subjects.length >= 4 ? "high" : "medium",
    });
  }

  // ---- 2 & 4. One pass for comments and import counts -----------------------
  const importCounts: Array<{ path: string; count: number }> = [];
  const importedStems = new Set<string>();

  for (const path of sourceFiles) {
    const text = readFile(root, path);
    if (text === null) continue;

    const isPython = extname(path) === ".py";

    for (const { line, body } of commentLines(text, isPython)) {
      const hit = WARNING_PATTERNS.find((p) => p.re.test(body));
      if (hit === undefined) continue;
      // A one-word comment carries no knowledge worth promoting.
      if (body.length < 12) continue;
      candidates.push({
        kind: "warning-comment",
        path,
        line,
        evidence: `${hit.label}: "${body.slice(0, 140)}"`,
        proposed: `\`${path}\`: ${body.slice(0, 200)}`,
        confidence: "medium",
      });
    }

    const imports = staticImports(text);
    importCounts.push({ path, count: imports.length });
    for (const spec of imports) importedStems.add(moduleStem(spec));
  }

  // ---- 3. Modules nothing imports statically, but config names --------------
  const configText = configFiles
    .map((f) => readFile(root, f) ?? "")
    .join("\n");

  for (const path of sourceFiles) {
    const stem = moduleStem(path);
    if (stem === "index" || stem === "__init__" || stem === "main") continue;
    if (importedStems.has(stem)) continue;
    // Whole-word match so `task` does not match `tasks_config`.
    const named = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(configText);
    if (!named) continue;

    candidates.push({
      kind: "non-static-entry",
      path,
      evidence: `nothing imports \`${stem}\`, but it is named in a config file — it is probably loaded dynamically`,
      proposed: `\`${path}\` looks unused but is not: it is referenced from configuration and loaded dynamically. Do not delete it.`,
      confidence: "high",
    });
  }

  // ---- 4. Anomalous coupling ------------------------------------------------
  if (importCounts.length >= 8) {
    const sorted = [...importCounts].sort((a, b) => a.count - b.count);
    const median = sorted[Math.floor(sorted.length / 2)]?.count ?? 0;
    const threshold = Math.max(median * 3, median + 8);
    for (const { path, count } of importCounts) {
      if (count <= threshold || count < 10) continue;
      candidates.push({
        kind: "anomalous-coupling",
        path,
        evidence: `${count} imports against a repo median of ${median}`,
        proposed: `\`${path}\` is unusually highly coupled (${count} imports vs a median of ${median}) — changes here reach a lot of the system.`,
        confidence: "low",
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  const ordered = candidates.sort(
    (a, b) => rank[a.confidence] - rank[b.confidence] || a.path.localeCompare(b.path),
  );
  return options.max === undefined ? ordered : ordered.slice(0, options.max);
}
