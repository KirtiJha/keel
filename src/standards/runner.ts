import { readFileSync } from "node:fs";

import type { KeelConfig, Language } from "../shared/config.js";
import { exec, pythonBin } from "../shared/exec.js";
import { changedLines as gitChangedLines } from "../shared/git.js";
import { matchesAny } from "../shared/glob.js";
import { logDebug, stopwatch } from "../shared/log.js";
import { toRepoRelative } from "../shared/paths.js";
import { errorMessage } from "../shared/result.js";
import { isPythonFile, isTypeScriptLike, parseSource } from "../shared/ast/ts.js";

import { type LoadedPack, loadPacks } from "./loader.js";
import { loadRule } from "./rule-loader.js";
import type { Finding, GateContext, GateResult, GateRunSummary, ReportedFinding } from "./types.js";

/**
 * The gate runner.
 *
 * The one non-negotiable here is diff-only evaluation. Every finding is
 * filtered against the set of lines this change touched, in this module, after
 * the rule returns. A pack cannot opt out and a pack author cannot forget —
 * which is what makes running these on a legacy repo survivable rather than
 * turning every edit into a cleanup project.
 */

export function languageOf(path: string): Language | null {
  if (isTypeScriptLike(path)) return "typescript";
  if (isPythonFile(path)) return "python";
  return null;
}

/** Gate packs that apply to one file. */
export function applicablePacks(
  packs: readonly LoadedPack[],
  repoRelPath: string,
  mode: "gate" | "guide" | "review",
): LoadedPack[] {
  const language = languageOf(repoRelPath);
  return packs.filter((p) => {
    if (p.standard.mode !== mode) return false;
    if (!matchesAny(repoRelPath, p.standard.applies_to)) return false;
    // A pack declaring only python must not fire on a .ts file even if its
    // globs are loose. Non-source files (.md, .yaml) match on globs alone.
    if (language !== null && !p.standard.languages.includes(language)) return false;
    return true;
  });
}

export interface RunGatesOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly config: KeelConfig;
  /** Absolute or repo-relative path of the file to check. */
  readonly filePath: string;
  /** File text. Read from disk when omitted. */
  readonly source?: string;
  /** Changed-line set. Derived from git when omitted. */
  readonly changedLines?: ReadonlySet<number>;
}

/** Run every applicable gate over one file. */
export async function runGates(options: RunGatesOptions): Promise<GateRunSummary> {
  const total = stopwatch();
  const repoRelPath = toRepoRelative(options.repoRoot, options.filePath);
  const empty = (): GateRunSummary => ({
    path: repoRelPath,
    results: [],
    blocking: [],
    advisory: [],
    durationMs: total(),
  });

  // Applicability is decided on paths alone, so it is settled *before* any I/O.
  // Most edits in a session match no gate pack at all, and for those this is
  // the whole cost: no file read, no `git diff`, no parse.
  const { packs } = loadPacks(options.repoRoot, options.pluginRoot, options.config);
  const applicable = applicablePacks(packs, repoRelPath, "gate");
  if (applicable.length === 0) return empty();

  const source = options.source ?? safeRead(options.repoRoot, repoRelPath);
  if (source === null) return empty();

  const changed =
    options.changedLines ?? gitChangedLines(options.repoRoot, repoRelPath);

  const language = languageOf(repoRelPath);
  const results: GateResult[] = [];

  // TypeScript rules run in-process. The AST is parsed once and shared by every
  // pack that wants it, so N packs cost one parse rather than N.
  const tsPacks = applicable.filter((p) => p.ruleTsPath !== null);
  const pyPacks = applicable.filter((p) => p.rulePyPath !== null && language === "python");

  const ast = tsPacks.length > 0 && language === "typescript"
    ? await parseSource(repoRelPath, source)
    : null;

  for (const pack of tsPacks) {
    // A python-only file must not be handed to a TypeScript rule.
    if (language === "python" && pack.rulePyPath !== null) continue;
    results.push(await runTsPack(options, pack, { path: repoRelPath, source, changedLines: changed, config: pack.standard.config, ast }));
  }

  if (pyPacks.length > 0) {
    results.push(...runPythonPacks(options, pyPacks, repoRelPath, source, changed));
  }

  const all = results.flatMap((r) => r.findings);
  return {
    path: repoRelPath,
    results,
    blocking: all.filter((f) => f.severity === "high"),
    advisory: all.filter((f) => f.severity !== "high"),
    durationMs: total(),
  };
}

/**
 * How long a single pack rule may take before the runner gives up on it.
 *
 * Generous next to the ~30 ms a real rule costs, and far below the hook timeout
 * registered in hooks.json, so a pathological pack degrades to one reported
 * error rather than a hook that appears to hang.
 *
 * This bounds rules that never *resolve*. A rule that blocks the event loop
 * outright — an infinite `for` loop — cannot be interrupted from inside the
 * process; the hooks.json timeout is the backstop for that, and Claude Code
 * treats a timed-out hook as non-blocking.
 */
const RULE_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T> | T, ms: number, packName: string): Promise<T> {
  return new Promise<T>((resolveWith, rejectWith) => {
    // Deliberately *not* unref'd. This timer is the only thing keeping the
    // event loop alive while a rule hangs; unref'ing it lets Node exit with
    // code 13 (unsettled top-level await) before the timeout can fire, which
    // turns a bounded failure back into an unbounded one.
    const timer = setTimeout(() => {
      rejectWith(new Error(`rule in pack \`${packName}\` did not finish within ${ms} ms`));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolveWith(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        rejectWith(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

function safeRead(root: string, repoRelPath: string): string | null {
  try {
    return readFileSync(`${root}/${repoRelPath}`, "utf8");
  } catch {
    return null;
  }
}

async function runTsPack(
  options: RunGatesOptions,
  pack: LoadedPack,
  context: GateContext,
): Promise<GateResult> {
  const timer = stopwatch();
  const loaded = await loadRule(options.repoRoot, pack);

  if (!loaded.ok) {
    // A broken rule reports an error and lets the edit through. A pack that
    // fails to compile must not block everyone who touches a matching file.
    logDebug("gate rule unavailable", { pack: pack.standard.name, error: loaded.error });
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: [],
      durationMs: timer(),
      error: loaded.error,
    };
  }

  const rule = loaded.value;
  if (rule === null) {
    return { pack: pack.standard.name, severity: pack.standard.severity, findings: [], durationMs: timer() };
  }

  try {
    const raw = await withTimeout(rule(context), RULE_TIMEOUT_MS, pack.standard.name);
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: reportable(raw, pack, context),
      durationMs: timer(),
    };
  } catch (cause) {
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: [],
      durationMs: timer(),
      error: errorMessage(cause),
    };
  }
}

interface PythonGateResponse {
  readonly results: ReadonlyArray<{
    readonly pack: string;
    readonly findings: readonly Finding[];
    readonly error?: string;
  }>;
}

function runPythonPacks(
  options: RunGatesOptions,
  packs: readonly LoadedPack[],
  repoRelPath: string,
  source: string,
  changed: ReadonlySet<number>,
): GateResult[] {
  const timer = stopwatch();
  const request = {
    path: repoRelPath,
    source,
    changed_lines: [...changed],
    packs: packs.map((p) => ({
      name: p.standard.name,
      rule_path: p.rulePyPath,
      config: p.standard.config,
    })),
  };

  const res = exec(pythonBin(), ["-m", "keel_gates.run"], {
    cwd: `${options.pluginRoot}/python`,
    input: JSON.stringify(request),
    timeoutMs: 10_000,
  });

  const elapsed = timer();

  if (!res.ok || res.value.code !== 0) {
    const error = res.ok ? res.value.stderr.trim() || `exit ${res.value.code}` : res.error;
    logDebug("python gate runner failed", { error });
    return packs.map((p) => ({
      pack: p.standard.name,
      severity: p.standard.severity,
      findings: [],
      durationMs: elapsed,
      error,
    }));
  }

  let parsed: PythonGateResponse;
  try {
    parsed = JSON.parse(res.value.stdout) as PythonGateResponse;
  } catch (cause) {
    return packs.map((p) => ({
      pack: p.standard.name,
      severity: p.standard.severity,
      findings: [],
      durationMs: elapsed,
      error: errorMessage(cause),
    }));
  }

  const byName = new Map(packs.map((p) => [p.standard.name, p]));
  const out: GateResult[] = [];
  for (const entry of parsed.results) {
    const pack = byName.get(entry.pack);
    if (pack === undefined) continue;
    out.push({
      pack: entry.pack,
      severity: pack.standard.severity,
      findings: reportable(entry.findings, pack, {
        path: repoRelPath,
        source,
        changedLines: changed,
        config: pack.standard.config,
        ast: null,
      }),
      durationMs: elapsed,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    });
  }
  return out;
}

/**
 * Apply the diff-only constraint and attach reporting metadata.
 *
 * This is the single place findings become visible, and the only place the
 * changed-line filter is applied. Both facts are deliberate.
 */
function reportable(
  findings: readonly Finding[],
  pack: LoadedPack,
  context: GateContext,
): ReportedFinding[] {
  const out: ReportedFinding[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!Number.isInteger(finding.line) || finding.line < 1) continue;
    if (!context.changedLines.has(finding.line)) continue;

    // One finding per rule per line: a rule that reports the same problem
    // twice should not produce two identical blocking messages.
    const key = `${finding.line}:${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      line: finding.line,
      ...(finding.column === undefined ? {} : { column: finding.column }),
      message: finding.message,
      fix: finding.fix,
      pack: pack.standard.name,
      severity: pack.standard.severity,
      path: context.path,
    });
  }

  return out.sort((a, b) => a.line - b.line || a.pack.localeCompare(b.pack));
}

/** Render a blocking summary for a hook's stderr. */
export function formatBlocking(summary: GateRunSummary): string {
  const lines = ["Keel standards gate blocked this edit:", ""];
  for (const f of summary.blocking) {
    lines.push(`  ${f.path}:${f.line}${f.column === undefined ? "" : `:${f.column}`}  [${f.pack}]`);
    lines.push(`    ${f.message}`);
    lines.push(`    fix: ${f.fix}`);
    lines.push("");
  }
  lines.push("Gates evaluate only the lines this change touched.");
  return lines.join("\n");
}
