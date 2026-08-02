import type { KeelConfig } from "../shared/config.js";
import { diffSummary, readWorkingFile, showFile } from "../shared/git.js";
import { isPythonFile, isTypeScriptLike } from "../shared/ast/ts.js";

import { cachedAsync, hashContent } from "./cache.js";
import { countCallers, diffSymbols, symbolsOf } from "./symbols.js";
import type { ChangeSignals, ChangedSymbol } from "./types.js";

export interface CollectOptions {
  /** Base ref to compare against; null compares the working tree to HEAD. */
  readonly against?: string | null;
  /** Plugin checkout root, used to locate the Python gate runner. */
  readonly pluginRoot: string;
  /** Skip caller counting. Used by tests and by `--fast`. */
  readonly skipCallers?: boolean;
}

function isAnalysable(path: string): boolean {
  return isTypeScriptLike(path) || isPythonFile(path);
}

/**
 * Gather everything `classify()` needs. This is the I/O half of the router:
 * git for the diff, the AST layer for symbols, git grep for caller counts.
 */
export async function collectSignals(
  root: string,
  config: KeelConfig,
  options: CollectOptions,
): Promise<ChangeSignals> {
  const against = options.against ?? null;
  const summary = diffSummary(root, against);
  const changedFiles = summary.files.map((f) => f.path);

  const changedSymbols: ChangedSymbol[] = [];

  for (const file of summary.files) {
    if (!isAnalysable(file.path)) continue;

    // A deleted module removes every symbol it exported, which is as much an
    // interface change as editing one. Comparing its old contents against an
    // empty file yields exactly that set.
    const after = file.status === "deleted" ? "" : readWorkingFile(root, file.path);
    if (after === null) continue;
    const before = file.status === "untracked" || file.status === "added"
      ? ""
      : (showFile(root, against ?? "HEAD", file.path) ?? "");

    // Content-hashed key: a stale entry is unaddressable, so never read.
    const key = hashContent(file.path, before, after);
    const deltas = await cachedAsync(root, "symbols", key, async () => {
      const beforeSymbols = before === "" ? [] : await symbolsOf(options.pluginRoot, file.path, before);
      const afterSymbols = await symbolsOf(options.pluginRoot, file.path, after);
      return diffSymbols(beforeSymbols, afterSymbols);
    });

    for (const delta of deltas) {
      const callers = options.skipCallers === true
        ? { count: 0, crossesPackageBoundary: false }
        : countCallers(root, delta.name, file.path, config.router.package_roots);

      changedSymbols.push({
        name: delta.name,
        file: file.path,
        change: delta.change,
        externalCallers: callers.count,
        crossesPackageBoundary: callers.crossesPackageBoundary,
      });
    }
  }

  return {
    changedFiles,
    addedLines: summary.addedLines,
    removedLines: summary.removedLines,
    changedExportedSymbols: changedSymbols,
    externalCallerCount: changedSymbols.reduce((max, s) => Math.max(max, s.externalCallers), 0),
  };
}
