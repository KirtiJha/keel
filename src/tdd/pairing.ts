import { basename, dirname, extname, join } from "node:path";

import { matchesAny } from "../shared/glob.js";
import { isFile } from "../shared/paths.js";

/**
 * Pair a source file with its test file and back.
 *
 * Gates 2 and 3 both need this: gate 2 to know which module a test is meant to
 * exercise, gate 3 to know which test should have been seen failing before a
 * symbol was implemented.
 *
 * Convention-based and deliberately generous. A missed pairing weakens a gate,
 * which is a far better failure than a wrong pairing blocking correct work.
 */

function posix(path: string): string {
  return path.split("\\").join("/");
}

export function isTestFile(repoRelPath: string, testGlobs: readonly string[]): boolean {
  return matchesAny(posix(repoRelPath), testGlobs);
}

/** Strip `.test` / `.spec` / `test_` / `_test` from a file's stem. */
export function stemOf(repoRelPath: string): string {
  const ext = extname(repoRelPath);
  let stem = basename(repoRelPath, ext);
  stem = stem.replace(/\.(?:test|spec)$/i, "");
  stem = stem.replace(/^test_/i, "");
  stem = stem.replace(/_test$/i, "");
  return stem;
}

/** Candidate test files for a source file, most conventional first. */
export function testCandidatesFor(repoRelPath: string): string[] {
  const ext = extname(repoRelPath);
  const dir = posix(dirname(repoRelPath));
  const stem = stemOf(repoRelPath);
  const out: string[] = [];

  if (ext === ".py") {
    out.push(
      posix(join(dir, `test_${stem}.py`)),
      posix(join(dir, `${stem}_test.py`)),
      posix(join("tests", `test_${stem}.py`)),
      posix(join("tests", dir, `test_${stem}.py`)),
      posix(join(dir.replace(/^[^/]+/, "tests"), `test_${stem}.py`)),
    );
  } else {
    for (const suffix of [".test", ".spec"]) {
      out.push(
        posix(join(dir, `${stem}${suffix}${ext}`)),
        posix(join(dir, "__tests__", `${stem}${suffix}${ext}`)),
        posix(join("tests", dir, `${stem}${suffix}${ext}`)),
        posix(join(dir.replace(/^src/, "tests"), `${stem}${suffix}${ext}`)),
      );
    }
  }

  return [...new Set(out)];
}

/** Candidate source files for a test file. */
export function sourceCandidatesFor(repoRelPath: string): string[] {
  const ext = extname(repoRelPath);
  const dir = posix(dirname(repoRelPath));
  const stem = stemOf(repoRelPath);
  const out: string[] = [];

  if (ext === ".py") {
    out.push(
      posix(join(dir, `${stem}.py`)),
      posix(join(dir.replace(/^tests?/, "src"), `${stem}.py`)),
      posix(join(dir.replace(/^tests?\/?/, ""), `${stem}.py`)),
      `${stem}.py`,
    );
  } else {
    const withoutTests = dir.replace(/\/__tests__$/, "");
    for (const candidate of [dir, withoutTests, dir.replace(/^tests/, "src")]) {
      for (const e of [ext, ".ts", ".tsx", ".js"]) {
        out.push(posix(join(candidate, `${stem}${e}`)));
      }
    }
  }

  return [...new Set(out)];
}

/** The first candidate test file that exists on disk. */
export function existingTestFor(root: string, repoRelPath: string): string | null {
  for (const candidate of testCandidatesFor(repoRelPath)) {
    if (isFile(join(root, candidate))) return candidate;
  }
  return null;
}

/** The first candidate source file that exists on disk. */
export function existingSourceFor(root: string, repoRelPath: string): string | null {
  for (const candidate of sourceCandidatesFor(repoRelPath)) {
    if (isFile(join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * Does a mocked module specifier refer to the module this test file covers?
 *
 * Specifiers are compared by stem because import styles vary wildly
 * (`./refresh.js`, `../auth/refresh`, `app.auth.refresh`) and resolving them
 * properly would need the module graph gate 3 deliberately avoids building.
 */
export function specifierTargetsModule(specifier: string, testFilePath: string): boolean {
  const target = stemOf(testFilePath);
  if (target === "") return false;

  const normalised = posix(specifier).replace(/\.(?:js|ts|tsx|mjs|cjs|py)$/i, "");
  const parts = normalised.split(/[/.]/).filter((p) => p !== "" && p !== "..");
  const last = parts[parts.length - 1];
  return last === target;
}
