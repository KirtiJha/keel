import { exec, pythonBin } from "../shared/exec.js";
import { compileGlobs } from "../shared/glob.js";
import { logDebug } from "../shared/log.js";
import { type SymbolRef, extractSymbols, isPythonFile, isTypeScriptLike, parseSource } from "../shared/ast/ts.js";

/**
 * Exported-symbol extraction across both languages.
 *
 * TypeScript goes through the compiler API (lazily loaded); Python goes through
 * the stdlib `ast` module in `python/keel_gates`. Both are single-file
 * syntactic passes — no type checker, no import graph.
 */

export interface PythonSymbolPayload {
  readonly symbols: ReadonlyArray<{
    readonly name: string;
    readonly kind: string;
    readonly line: number;
    readonly exported: boolean;
    readonly signature: string;
  }>;
}

/** Public symbols declared in a source file. Empty for unsupported languages. */
export async function symbolsOf(
  pluginRoot: string,
  filePath: string,
  text: string,
): Promise<SymbolRef[]> {
  if (isTypeScriptLike(filePath)) {
    const parsed = await parseSource(filePath, text);
    if (parsed === null) return [];
    return extractSymbols(parsed);
  }

  if (isPythonFile(filePath)) {
    return pythonSymbols(pluginRoot, filePath, text);
  }

  return [];
}

function pythonSymbols(pluginRoot: string, filePath: string, text: string): SymbolRef[] {
  const res = exec(pythonBin(), ["-m", "keel_gates.symbols"], {
    cwd: `${pluginRoot}/python`,
    input: JSON.stringify({ path: filePath, source: text }),
    timeoutMs: 5000,
  });

  if (!res.ok || res.value.code !== 0) {
    logDebug("python symbol extraction unavailable", {
      code: res.ok ? res.value.code : -1,
    });
    return [];
  }

  try {
    const payload = JSON.parse(res.value.stdout) as PythonSymbolPayload;
    return payload.symbols.map((s) => ({
      name: s.name,
      kind: "function",
      line: s.line,
      exported: s.exported,
      signature: s.signature,
    }));
  } catch {
    return [];
  }
}

export type SymbolChange = "added" | "removed" | "signature-changed";

export interface SymbolDelta {
  readonly name: string;
  readonly change: SymbolChange;
  readonly line: number;
}

/**
 * Compare two symbol sets. Only exported symbols count — a private helper
 * changing shape is not an interface change and must not escalate the track.
 */
export function diffSymbols(
  before: readonly SymbolRef[],
  after: readonly SymbolRef[],
): SymbolDelta[] {
  const beforeMap = new Map(before.filter((s) => s.exported).map((s) => [s.name, s]));
  const afterMap = new Map(after.filter((s) => s.exported).map((s) => [s.name, s]));
  const deltas: SymbolDelta[] = [];

  for (const [name, sym] of afterMap) {
    const prev = beforeMap.get(name);
    if (prev === undefined) {
      deltas.push({ name, change: "added", line: sym.line });
    } else if (prev.signature !== sym.signature) {
      deltas.push({ name, change: "signature-changed", line: sym.line });
    }
  }

  for (const [name, sym] of beforeMap) {
    if (!afterMap.has(name)) {
      deltas.push({ name, change: "removed", line: sym.line });
    }
  }

  return deltas.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The package a file belongs to, per `router.package_roots`.
 *
 * Walks path prefixes shortest-first and returns the first that matches a
 * package-root glob, so `packages/*` maps `packages/api/src/x.ts` to
 * `packages/api`. Returns null for files outside every declared package.
 */
export function packageRootOf(
  repoRelPath: string,
  packageRoots: readonly string[],
): string | null {
  if (packageRoots.length === 0) return null;
  const match = compileGlobs(packageRoots);
  const parts = repoRelPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    if (match(prefix)) return prefix;
  }
  return null;
}

export interface CallerInfo {
  /** Distinct files referencing the symbol, excluding the declaring file. */
  readonly count: number;
  readonly crossesPackageBoundary: boolean;
}

/**
 * Count references to a symbol across the repo.
 *
 * `git grep -l -w` is a whole-word, index-backed search: fast on large repos
 * and good enough for a routing signal. It is deliberately not a resolved
 * reference graph — building one would need the persistent index M3 rules out.
 * Over-counting escalates the track, which is the safe direction to be wrong in.
 */
export function countCallers(
  root: string,
  symbolName: string,
  declaringFile: string,
  packageRoots: readonly string[],
): CallerInfo {
  // Reject anything that is not a plain identifier before it reaches git grep.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbolName)) {
    return { count: 0, crossesPackageBoundary: false };
  }

  const res = exec(
    "git",
    [
      "grep",
      "--untracked",
      "-l",
      "-w",
      "--fixed-strings",
      "-e",
      symbolName,
      // `--untracked` otherwise reaches Keel's own symbol cache, where every
      // analysed name appears as JSON and would be counted as a caller.
      "--",
      ":(exclude).keel",
    ],
    { cwd: root, timeoutMs: 8000 },
  );

  // Exit 1 from git grep means "no matches", which is a valid answer.
  if (!res.ok || (res.value.code !== 0 && res.value.code !== 1)) {
    return { count: 0, crossesPackageBoundary: false };
  }

  const declaringPackage = packageRootOf(declaringFile, packageRoots);
  let count = 0;
  let crosses = false;

  for (const file of res.value.stdout.split("\n")) {
    const path = file.trim();
    if (path === "" || path === declaringFile) continue;
    count++;
    if (packageRootOf(path, packageRoots) !== declaringPackage) crosses = true;
  }

  return { count, crossesPackageBoundary: crosses };
}
