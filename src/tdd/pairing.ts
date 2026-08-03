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

/**
 * Directory names that conventionally hold tests.
 *
 * `test` singular is mocha's default and `spec` is the jasmine/rspec habit;
 * leaving either out means a repo that uses it has *no* candidate at all, and
 * gate 3 then reports "no test file exists for this module" about a module that
 * has one. That is the worst thing this file can do.
 */
const TEST_ROOTS = ["__tests__", "tests", "test", "spec"] as const;

/** Source directory names a test tree commonly mirrors or replaces. */
const SOURCE_ROOTS: readonly string[] = ["src", "lib", "app"];

/**
 * Every directory a test for a file in `dir` might plausibly live in.
 *
 * Deliberately over-generous: each entry costs one `statSync` and only matters
 * if a file actually exists there, whereas a missing entry costs a developer a
 * blocked edit on correct TDD.
 */
function testDirsFor(dir: string): string[] {
  const out: string[] = [dir];
  const segments = dir === "." || dir === "" ? [] : dir.split("/");
  const belowFirst = segments.slice(1).join("/");
  const sourceIndex = segments.findIndex((s) => SOURCE_ROOTS.includes(s));

  // Colocated: `src/util/__tests__/money.test.js`.
  for (const root of TEST_ROOTS) out.push(posix(join(dir, root)));

  for (const root of TEST_ROOTS) {
    // Flat, which is what `vitest`/`jest`/`mocha` produce out of the box:
    // `tests/money.test.js` for `src/util/money.js`.
    out.push(root);
    // Mirrored whole path: `tests/src/util/money.test.js`.
    out.push(posix(join(root, dir)));
    // First segment swapped for the test root: `tests/util/money.test.js`.
    if (belowFirst !== "") out.push(posix(join(root, belowFirst)));
    // Package-local, for monorepos: `packages/x/tests/util/money.test.js`
    // and the flat `packages/x/tests/money.test.js`.
    if (sourceIndex >= 0) {
      const prefix = segments.slice(0, sourceIndex).join("/");
      const suffix = segments.slice(sourceIndex + 1).join("/");
      out.push(posix(join(prefix, root, suffix)));
      out.push(posix(join(prefix, root)));
    }
  }

  return [...new Set(out)];
}

/**
 * Extensions a test for a source file with this extension might carry.
 *
 * A `.tsx` component tested from a plain `.ts` file is ordinary, and so is a
 * `.mjs` module tested from `.js`.
 */
function testExtensionsFor(ext: string): string[] {
  switch (ext) {
    case ".ts":
      return [".ts", ".tsx"];
    case ".tsx":
      return [".tsx", ".ts"];
    case ".js":
      return [".js", ".jsx"];
    case ".jsx":
      return [".jsx", ".js"];
    case ".mjs":
    case ".cjs":
    case ".mts":
    case ".cts":
      return [ext, ".ts", ".js"];
    default:
      return [ext];
  }
}

/** Candidate test files for a source file, most conventional first. */
export function testCandidatesFor(repoRelPath: string): string[] {
  const ext = extname(repoRelPath);
  const dir = posix(dirname(repoRelPath));
  const stem = stemOf(repoRelPath);
  const dirs = testDirsFor(dir);
  const out: string[] = [];

  if (ext === ".py") {
    for (const name of [`test_${stem}.py`, `${stem}_test.py`]) {
      for (const candidate of dirs) out.push(posix(join(candidate, name)));
    }
  } else {
    for (const suffix of [".test", ".spec"]) {
      for (const testExt of testExtensionsFor(ext)) {
        for (const candidate of dirs) {
          out.push(posix(join(candidate, `${stem}${suffix}${testExt}`)));
        }
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

/**
 * Does a mocked module specifier refer to the module this test file covers?
 *
 * Specifiers are compared by stem because import styles vary wildly
 * (`./refresh.js`, `../auth/refresh`, `app.auth.refresh`) and resolving them
 * properly would need the module graph gate 3 deliberately avoids building.
 *
 * The last segment is not always the module. `unittest.mock` patches
 * *attributes*: `patch("app.service.charge")` names the function `charge`
 * inside the module `app.service`, and comparing only `charge` to the stem of
 * `test_service.py` meant gate 2 caught nothing at all in Python — only the
 * rare bare `patch("app.service")` ever fired. A dotted specifier with no path
 * separator is therefore also matched one segment in.
 *
 * One segment, not any: `patch("other.module.thing")` from `test_service.py`
 * must stay clean, and matching anywhere in the specifier would make every
 * `patch("app.…")` from `test_app.py` a violation.
 */
export function specifierTargetsModule(specifier: string, testFilePath: string): boolean {
  const target = stemOf(testFilePath);
  if (target === "") return false;

  const normalised = posix(specifier).replace(/\.(?:js|ts|tsx|mjs|cjs|py)$/i, "");
  const parts = normalised.split(/[/.]/).filter((p) => p !== "" && p !== "." && p !== "..");
  if (parts.length === 0) return false;
  if (parts[parts.length - 1] === target) return true;

  // `module.attribute`, which only a dotted (Python-style) specifier can be:
  // in `../auth/refresh` the second-to-last segment is a *directory*, and
  // treating it as the module under test would block a test that legitimately
  // mocks a sibling of its own module.
  const dotted = !normalised.includes("/");
  return dotted && parts.length >= 2 && parts[parts.length - 2] === target;
}
