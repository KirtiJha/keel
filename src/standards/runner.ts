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
import { ruleTrust } from "./trust.js";
import type {
  Finding,
  GateContext,
  GateResult,
  GateRunSummary,
  GateStatus,
  ReportedFinding,
} from "./types.js";

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
  /** Whole-run deadline in ms. Defaults to `RUN_BUDGET_MS`. */
  readonly budgetMs?: number;
}

/**
 * Largest file the gates will look at.
 *
 * Well past any hand-written source file and well short of the generated ones.
 * An 18 MB bundle committed into `src/` took 17.6 s to parse and check against
 * a 30 s hook timeout, and produced 146 KB of findings — around 35k tokens fed
 * back into the model from a single edit. Nothing about that was a useful
 * signal, so the file is skipped and the edit proceeds.
 */
export const MAX_GATED_FILE_CHARS = 512 * 1024;

/**
 * Whole-run deadline for every pack over one file.
 *
 * `RULE_TIMEOUT_MS` bounds one rule; packs are awaited in sequence, so without
 * this nothing bounded the *sum*. Twenty packs each returning a promise that
 * never settles ran the hook for 40.9 s against its registered 30 s timeout —
 * every rule respected its own timeout and the hook still overran. Past the
 * deadline the remaining packs are not started and are reported as skipped.
 */
export const RUN_BUDGET_MS = 5000;

/** Run every applicable gate over one file. */
export async function runGates(options: RunGatesOptions): Promise<GateRunSummary> {
  const total = stopwatch();
  const repoRelPath = toRepoRelative(options.repoRoot, options.filePath);
  const budget = options.budgetMs ?? RUN_BUDGET_MS;
  const remaining = (): number => budget - total();

  const nothing = (skipped: readonly string[] = []): GateRunSummary =>
    summarise(repoRelPath, [], skipped, total());

  // Applicability is decided on paths alone, so it is settled *before* any I/O.
  // Most edits in a session match no gate pack at all, and for those this is
  // the whole cost: no file read, no `git diff`, no parse.
  const { packs } = loadPacks(options.repoRoot, options.pluginRoot, options.config);
  const applicable = applicablePacks(packs, repoRelPath, "gate");
  if (applicable.length === 0) return nothing();

  const source = options.source ?? safeRead(options.repoRoot, repoRelPath);
  if (source === null) return nothing();

  // Before the parse, and before git is asked for a diff of it.
  if (source.length > MAX_GATED_FILE_CHARS) {
    logDebug("skipping gates: file too large", {
      path: repoRelPath,
      chars: source.length,
      limit: MAX_GATED_FILE_CHARS,
    });
    return nothing(applicable.map((p) => p.standard.name));
  }

  // Diff-only is not a preference, it is the property that makes these gates
  // usable on a legacy repo. When git cannot tell us which lines changed we do
  // not fall back to the whole file — we report nothing and let the edit
  // through. A gate that blocks because git is missing is a broken gate.
  let changed: ReadonlySet<number>;
  if (options.changedLines !== undefined) {
    changed = options.changedLines;
  } else {
    const resolved = gitChangedLines(options.repoRoot, repoRelPath);
    if (!resolved.known) {
      logDebug("skipping gates: changed lines unknown", {
        path: repoRelPath,
        reason: resolved.reason,
      });
      return nothing();
    }
    changed = resolved.lines;
  }

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

    const left = remaining();
    if (left <= 0) {
      results.push(notRun(pack, "skipped", `the ${budget} ms gate budget for this file ran out`, 0));
      continue;
    }
    results.push(
      await runTsPack(
        options,
        pack,
        { path: repoRelPath, source, changedLines: changed, config: pack.standard.config, ast },
        Math.min(RULE_TIMEOUT_MS, left),
      ),
    );
  }

  if (pyPacks.length > 0) {
    const left = remaining();
    if (left <= 0) {
      for (const pack of pyPacks) {
        results.push(notRun(pack, "skipped", `the ${budget} ms gate budget for this file ran out`, 0));
      }
    } else {
      results.push(...runPythonPacks(options, pyPacks, repoRelPath, source, changed, left));
    }
  }

  return summarise(repoRelPath, results, [], total());
}

/** A pack that produced no verdict, and why. Never a finding, never a block. */
function notRun(
  pack: LoadedPack,
  status: "untrusted" | "skipped",
  detail: string,
  durationMs: number,
): GateResult {
  return {
    pack: pack.standard.name,
    severity: pack.standard.severity,
    findings: [],
    durationMs,
    status,
    detail,
  };
}

/**
 * Fold results into the summary the hook reads.
 *
 * `health` exists because "the standards gates passed" and "the standards gates
 * did not run" were previously the same observable state: the hook checked
 * `results.length > 0` and recorded a tick. A pack whose rule threw, or was
 * never approved, or ran out of budget therefore reported as a pass, which is
 * the single worst thing a gate can do.
 */
function summarise(
  path: string,
  results: readonly GateResult[],
  skippedPacks: readonly string[],
  durationMs: number,
): GateRunSummary {
  const all = results.flatMap((r) => r.findings);
  const names = (status: GateStatus): string[] =>
    results.filter((r) => r.status === status).map((r) => r.pack);

  const ran = names("ok");
  const errored = names("error");
  const untrusted = names("untrusted");
  const skipped = [...names("skipped"), ...skippedPacks];

  const parts: string[] = [];
  if (errored.length > 0) parts.push(`${errored.length} errored (${errored.join(", ")})`);
  if (untrusted.length > 0) parts.push(`${untrusted.length} not approved to run (${untrusted.join(", ")})`);
  if (skipped.length > 0) parts.push(`${skipped.length} skipped (${skipped.join(", ")})`);

  return {
    path,
    results,
    blocking: all.filter((f) => f.severity === "high"),
    advisory: all.filter((f) => f.severity !== "high"),
    durationMs,
    health: {
      ran,
      errored,
      untrusted,
      skipped,
      complete: errored.length === 0 && untrusted.length === 0 && skipped.length === 0,
      detail: parts.join("; "),
    },
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
  timeoutMs: number,
): Promise<GateResult> {
  const timer = stopwatch();
  const loaded = await loadRule(options.repoRoot, options.pluginRoot, pack);

  if (loaded.kind === "untrusted") {
    // Not a failure: a repo-local rule is code, and this repository has not
    // approved running it. Reported, never blocking — `keel trust` is the way
    // in, and a hook must not prompt.
    return notRun(pack, "untrusted", loaded.reason, timer());
  }

  if (loaded.kind === "error") {
    // A broken rule reports an error and lets the edit through. A pack that
    // fails to compile must not block everyone who touches a matching file.
    logDebug("gate rule unavailable", { pack: pack.standard.name, error: loaded.error });
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: [],
      durationMs: timer(),
      status: "error",
      error: loaded.error,
    };
  }

  if (loaded.kind === "none") {
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: [],
      durationMs: timer(),
      status: "ok",
    };
  }

  try {
    const raw = await withTimeout(loaded.rule(context), timeoutMs, pack.standard.name);
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: reportable(raw, pack, context),
      durationMs: timer(),
      status: "ok",
    };
  } catch (cause) {
    return {
      pack: pack.standard.name,
      severity: pack.standard.severity,
      findings: [],
      durationMs: timer(),
      status: "error",
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
  budgetLeftMs: number,
): GateResult[] {
  const out: GateResult[] = [];

  // `rule.py` is handed to the interpreter and executed there — the same
  // decision as importing a `rule.ts`, so the same approval gates it.
  const runnable: LoadedPack[] = [];
  for (const pack of packs) {
    const trust = ruleTrust(options.repoRoot, options.pluginRoot, pack, pack.rulePyPath ?? "");
    if (trust.kind === "untrusted") {
      logDebug("pack rule not run: untrusted", { pack: pack.standard.name, reason: trust.reason });
      out.push(notRun(pack, "untrusted", trust.reason, 0));
      continue;
    }
    runnable.push(pack);
  }
  if (runnable.length === 0) return out;

  const timer = stopwatch();
  const request = {
    path: repoRelPath,
    source,
    changed_lines: [...changed],
    packs: runnable.map((p) => ({
      name: p.standard.name,
      rule_path: p.rulePyPath,
      config: p.standard.config,
    })),
  };

  const res = exec(pythonBin(), ["-m", "keel_gates.run"], {
    cwd: `${options.pluginRoot}/python`,
    input: JSON.stringify(request),
    // Never past what is left of the whole-file budget: the interpreter is one
    // more thing that must not push the hook past its own timeout.
    timeoutMs: Math.max(1, Math.min(10_000, Math.round(budgetLeftMs))),
  });

  const elapsed = timer();

  if (!res.ok || res.value.code !== 0) {
    const error = res.ok ? res.value.stderr.trim() || `exit ${res.value.code}` : res.error;
    logDebug("python gate runner failed", { error });
    for (const p of runnable) {
      out.push({
        pack: p.standard.name,
        severity: p.standard.severity,
        findings: [],
        durationMs: elapsed,
        status: "error",
        error,
      });
    }
    return out;
  }

  let parsed: PythonGateResponse;
  try {
    parsed = JSON.parse(res.value.stdout) as PythonGateResponse;
  } catch (cause) {
    for (const p of runnable) {
      out.push({
        pack: p.standard.name,
        severity: p.standard.severity,
        findings: [],
        durationMs: elapsed,
        status: "error",
        error: errorMessage(cause),
      });
    }
    return out;
  }

  const byName = new Map(runnable.map((p) => [p.standard.name, p]));
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
      status: entry.error === undefined ? "ok" : "error",
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

/**
 * Caps on what a blocking message may cost.
 *
 * This text is stderr from a PostToolUse hook, which means it is fed straight
 * back into the model's context. One edit to an 18 MB file rendered 146 KB of
 * findings — roughly 35k tokens — and the model then had to read all of it to
 * find out what to change. Twenty findings is already more than anyone acts on
 * in one pass, and a rule is free to return a message of any length, so both
 * the count and the size are bounded. Truncation always says so: silently
 * dropping findings would be worse than printing them.
 */
export const MAX_RENDERED_FINDINGS = 20;
export const MAX_BLOCKING_CHARS = 8000;
const MAX_FIELD_CHARS = 300;

function clip(text: string, limit = MAX_FIELD_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** Render a blocking summary for a hook's stderr. */
export function formatBlocking(summary: GateRunSummary): string {
  const header = ["Keel standards gate blocked this edit:", ""];
  const footer = "Gates evaluate only the lines this change touched.";

  const lines: string[] = [];
  let size = 0;
  let shown = 0;

  for (const f of summary.blocking) {
    if (shown >= MAX_RENDERED_FINDINGS) break;
    const block = [
      `  ${f.path}:${f.line}${f.column === undefined ? "" : `:${f.column}`}  [${f.pack}]`,
      `    ${clip(f.message)}`,
      `    fix: ${clip(f.fix)}`,
      "",
    ];
    const cost = block.reduce((n, l) => n + l.length + 1, 0);
    if (shown > 0 && size + cost > MAX_BLOCKING_CHARS) break;
    lines.push(...block);
    size += cost;
    shown++;
  }

  const hidden = summary.blocking.length - shown;
  if (hidden > 0) {
    lines.push(`  …and ${hidden} more finding${hidden === 1 ? "" : "s"} not shown.`, "");
  }

  return [...header, ...lines, footer].join("\n");
}
