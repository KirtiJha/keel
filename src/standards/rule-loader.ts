import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadTypeScript } from "../shared/ast/ts.js";
import { logDebug } from "../shared/log.js";
import { keelSubdir } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import type { LoadedPack } from "./loader.js";
import { isPluginPack, machineMac, macEquals, ruleTrust, sha256Bytes, type TrustOptions } from "./trust.js";
import type { Rule } from "./types.js";

/**
 * Load a pack's TypeScript rule.
 *
 * **This module executes code.** Everything it imports runs in-process with the
 * developer's full privileges, so the two questions it has to answer before an
 * `import()` are "am I allowed to run this pack at all" (`./trust.ts`) and "are
 * these the bytes that pack's source compiles to" (the cache stamp below).
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
 *
 * ## Why the cache is stamped
 *
 * The cache key used to be `sha256(rule.ts)` and a cache *hit* was decided by
 * `isFile(path)` alone — the bytes were never checked against the source they
 * claimed to come from. Two consequences, both observed:
 *
 *   - A repo could commit `.keel/cache/packs/<pack>-<hash>.mjs`. That file was
 *     imported and the `rule.ts` a reviewer read was never compiled. The
 *     malicious code survived code review because it was never *in* the review.
 *   - A truncated or corrupted write left a broken `.mjs` under the key of a
 *     perfectly good source, permanently: the gate died and the hook still
 *     reported "checks passed".
 *
 * So an artifact now carries a first-line stamp naming the source hash, the
 * hash of its own body, and an HMAC over both under this machine's key (which
 * lives outside every repository). An artifact that does not verify is not
 * evidence of anything, and is recompiled rather than trusted. Writes go
 * through a temp file and a rename, so a half-written artifact is never
 * visible under the real name.
 */

const ruleCache = new Map<string, Rule>();

/** `//# keel-rule 1 <sourceSha256> <bodySha256> <mac>` */
const STAMP_PREFIX = "//# keel-rule 1 ";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function artifactPath(repoRoot: string, pack: LoadedPack, sourceSha: string): string {
  return join(keelSubdir(repoRoot, "cache", "packs"), `${pack.standard.name}-${sourceSha.slice(0, 24)}.mjs`);
}

function stampFor(sourceSha: string, body: string): string | null {
  const mac = machineMac(["keel-rule-cache/1", sourceSha, sha256(body)], /* create */ true);
  return mac === null ? null : `${STAMP_PREFIX}${sourceSha} ${sha256(body)} ${mac}`;
}

/**
 * True when the artifact on disk really is the compiled form of `sourceSha`,
 * as recorded by this machine. Any doubt answers false and the caller
 * recompiles — the cost of being wrong here is one transpile.
 */
function artifactVerifies(path: string, sourceSha: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }

  const newline = text.indexOf("\n");
  if (newline < 0) return false;
  const stamp = text.slice(0, newline);
  const body = text.slice(newline + 1);
  if (!stamp.startsWith(STAMP_PREFIX)) return false;

  const [claimedSource, claimedBody, mac] = stamp.slice(STAMP_PREFIX.length).split(" ");
  if (claimedSource !== sourceSha) return false;
  if (claimedBody === undefined || claimedBody !== sha256(body)) return false;

  return macEquals(mac ?? null, machineMac(["keel-rule-cache/1", sourceSha, claimedBody]));
}

/** An import specifier for the compiled rule: a cached file, or the code itself. */
async function compileTypeScriptRule(
  repoRoot: string,
  pack: LoadedPack,
  sourcePath: string,
  source: string,
  sourceSha: string,
): Promise<Result<string, string>> {
  const outPath = artifactPath(repoRoot, pack, sourceSha);
  if (artifactVerifies(outPath, sourceSha)) return ok(pathToFileURL(outPath).href);

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

  const body = transpiled.outputText;
  const stamp = stampFor(sourceSha, body);

  // No key, or an unwritable cache: run the code we just produced in memory
  // rather than either giving up on the gate or writing an artifact we could
  // not later tell apart from someone else's.
  if (stamp === null) {
    logDebug("compiled rule not cached: no machine key", { pack: pack.standard.name });
    return ok(dataUrl(body));
  }

  const tmp = `${outPath}.${process.pid}.tmp`;
  try {
    mkdirSync(keelSubdir(repoRoot, "cache", "packs"), { recursive: true });
    writeFileSync(tmp, `${stamp}\n${body}`, "utf8");
    renameSync(tmp, outPath);
  } catch (cause) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing useful to do; the import below does not depend on the cache.
    }
    logDebug("compiled rule not cached", { pack: pack.standard.name, error: errorMessage(cause) });
    return ok(dataUrl(body));
  }

  return ok(pathToFileURL(outPath).href);
}

function dataUrl(code: string): string {
  return `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
}

function asRule(module: unknown): Rule | null {
  if (typeof module !== "object" || module === null) return null;
  const candidate = (module as { default?: unknown }).default ?? (module as { rule?: unknown }).rule;
  return typeof candidate === "function" ? (candidate as Rule) : null;
}

/**
 * The outcome of resolving a pack's rule to a callable.
 *
 * `untrusted` is deliberately not an error: nothing is broken, the pack is code
 * this repository has not been approved to run. The caller reports it and lets
 * the edit through.
 */
export type LoadedRule =
  | { readonly kind: "rule"; readonly rule: Rule }
  | { readonly kind: "none" }
  | { readonly kind: "untrusted"; readonly reason: string }
  | { readonly kind: "error"; readonly error: string };

export async function loadRule(
  repoRoot: string,
  pluginRoot: string,
  pack: LoadedPack,
  trustOptions: TrustOptions = {},
): Promise<LoadedRule> {
  const sourcePath = pack.ruleTsPath;
  if (sourcePath === null) return { kind: "none" };

  const cacheKey = `${pack.dir}::${sourcePath}`;
  const memo = ruleCache.get(cacheKey);
  // A pack shipped inside the plugin has nothing to verify, so the memoised
  // rule is the whole answer. Three hooks call this on every tool call; the
  // common case must not pay for a file read it cannot learn anything from.
  if (memo !== undefined && isPluginPack(pack, pluginRoot)) return { kind: "rule", rule: memo };

  let raw: Buffer;
  try {
    raw = readFileSync(sourcePath);
  } catch (cause) {
    return { kind: "error", error: errorMessage(cause) };
  }

  // Decided on the bytes we are about to compile, not on a second read of the
  // path, and always before the import.
  const trust = ruleTrust(repoRoot, pluginRoot, pack, sourcePath, raw, trustOptions);
  if (trust.kind === "untrusted") {
    logDebug("pack rule not run: untrusted", { pack: pack.standard.name, reason: trust.reason });
    return { kind: "untrusted", reason: trust.reason };
  }

  if (memo !== undefined) return { kind: "rule", rule: memo };

  try {
    const source = raw.toString("utf8");
    const needsCompile = sourcePath.endsWith(".ts") || sourcePath.endsWith(".mts");
    const specifier = needsCompile
      ? await compileTypeScriptRule(repoRoot, pack, sourcePath, source, sha256Bytes(raw))
      : ok(pathToFileURL(sourcePath).href);

    if (!specifier.ok) return { kind: "error", error: specifier.error };

    const imported: unknown = await import(specifier.value);
    const rule = asRule(imported);
    if (rule === null) {
      return { kind: "error", error: "rule module has no default export that is a function" };
    }

    ruleCache.set(cacheKey, rule);
    return { kind: "rule", rule };
  } catch (cause) {
    logDebug("rule load failed", { pack: pack.standard.name, error: errorMessage(cause) });
    return { kind: "error", error: errorMessage(cause) };
  }
}

/** Drop memoised rules. Test-only seam. */
export function resetRuleCache(): void {
  ruleCache.clear();
}
