import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadTypeScript } from "../shared/ast/ts.js";
import { logDebug } from "../shared/log.js";
import { keelSubdir, isFile } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import type { LoadedPack } from "./loader.js";
import type { Rule } from "./types.js";

/**
 * Load a pack's TypeScript rule.
 *
 * Packs are authored in TypeScript (`rule.ts`) because that is what the rest of
 * the codebase is, but `import()` cannot execute TypeScript. Rather than push a
 * build step onto every team that adds a standard — which would break "adding a
 * standard = add a folder, open a PR" — the rule is transpiled on demand with
 * `ts.transpileModule` and cached under `.keel/cache/packs/` by content hash.
 *
 * Transpilation is ~1 ms once the compiler is resident, and the compiler is
 * already loaded whenever an AST gate is running. Steady state is a cache hit
 * and a plain dynamic import.
 *
 * Rules may only use `import type` for their imports: transpilation is
 * single-file, so a value import would not resolve at runtime.
 */

const ruleCache = new Map<string, Rule | null>();

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

async function compileTypeScriptRule(
  repoRoot: string,
  pack: LoadedPack,
  sourcePath: string,
): Promise<Result<string, string>> {
  const source = readFileSync(sourcePath, "utf8");
  const cacheDir = keelSubdir(repoRoot, "cache", "packs");
  const outPath = join(cacheDir, `${pack.standard.name}-${hash(source)}.mjs`);

  if (isFile(outPath)) return ok(outPath);

  const ts = await loadTypeScript();
  if (ts === null) {
    return err("the TypeScript compiler is unavailable, so rule.ts cannot be compiled");
  }

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      // Type-only imports must vanish: the emitted module resolves nothing.
      verbatimModuleSyntax: false,
      isolatedModules: true,
    },
    fileName: sourcePath,
  });

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(outPath, transpiled.outputText, "utf8");
  } catch (cause) {
    return err(`could not cache compiled rule: ${errorMessage(cause)}`);
  }

  return ok(outPath);
}

function asRule(module: unknown): Rule | null {
  if (typeof module !== "object" || module === null) return null;
  const candidate = (module as { default?: unknown }).default ?? (module as { rule?: unknown }).rule;
  return typeof candidate === "function" ? (candidate as Rule) : null;
}

/**
 * Resolve a pack's rule to a callable. Returns null when the pack has no
 * TypeScript rule; returns an error when it has one that will not load.
 */
export async function loadRule(
  repoRoot: string,
  pack: LoadedPack,
): Promise<Result<Rule | null, string>> {
  const sourcePath = pack.ruleTsPath;
  if (sourcePath === null) return ok(null);

  const cacheKey = `${pack.dir}::${sourcePath}`;
  const memo = ruleCache.get(cacheKey);
  if (memo !== undefined) return ok(memo);

  try {
    const needsCompile = sourcePath.endsWith(".ts") || sourcePath.endsWith(".mts");
    const modulePath = needsCompile
      ? await compileTypeScriptRule(repoRoot, pack, sourcePath)
      : ok(sourcePath);

    if (!modulePath.ok) return modulePath;

    const imported: unknown = await import(pathToFileURL(modulePath.value).href);
    const rule = asRule(imported);
    if (rule === null) {
      return err("rule module has no default export that is a function");
    }

    ruleCache.set(cacheKey, rule);
    return ok(rule);
  } catch (cause) {
    logDebug("rule load failed", { pack: pack.standard.name, error: errorMessage(cause) });
    return err(errorMessage(cause));
  }
}

/** Drop memoised rules. Test-only seam. */
export function resetRuleCache(): void {
  ruleCache.clear();
}
