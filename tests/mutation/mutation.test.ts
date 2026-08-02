import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateMutants, generateTypeScriptMutants } from "../../src/mutation/generate.js";
import { applyMutant, selectMutants, type Mutant } from "../../src/mutation/operators.js";
import { resolveTestCommand, runMutation } from "../../src/mutation/runner.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-mutation-");
});

afterEach(() => {
  repo.dispose();
});

const ALL_LINES = new Set(Array.from({ length: 200 }, (_, i) => i + 1));

async function tsMutants(source: string, lines: ReadonlySet<number> = ALL_LINES) {
  return generateTypeScriptMutants("src/m.ts", source, {
    changedLines: lines,
    pluginRoot: PLUGIN_ROOT,
  });
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

describe("TypeScript mutant generation", () => {
  it.each([
    ["conditional boundary", "export const f = (a: number) => a > 1;", "conditional-boundary", ">="],
    ["equality", "export const f = (a: number) => a === 1;", "negate-conditional", "!=="],
    ["arithmetic", "export const f = (a: number) => a + 1;", "arithmetic", "-"],
    ["logical", "export const f = (a: boolean, b: boolean) => a && b;", "logical", "||"],
  ])("mutates %s", async (_name, source, operator, replacement) => {
    const mutants = await tsMutants(source);
    const found = mutants.find((m) => m.operator === operator);
    expect(found, `expected a ${operator} mutant`).toBeDefined();
    expect(found?.replacement).toBe(replacement);
  });

  it("mutates boolean literals both ways", async () => {
    const on = await tsMutants("export const f = () => true;");
    expect(on.find((m) => m.operator === "boolean-literal")?.replacement).toBe("false");

    const off = await tsMutants("export const f = () => false;");
    expect(off.find((m) => m.operator === "boolean-literal")?.replacement).toBe("true");
  });

  it("empties non-empty string literals", async () => {
    const mutants = await tsMutants('export const f = () => "hello";');
    expect(mutants.find((m) => m.operator === "string-literal")?.replacement).toBe('""');
  });

  it("does not mutate import specifiers — that breaks the module, not the test", async () => {
    const mutants = await tsMutants('import { a } from "./other.js";\nexport const b = a;');
    expect(mutants.filter((m) => m.operator === "string-literal")).toEqual([]);
  });

  it("nulls a return value", async () => {
    const mutants = await tsMutants("export function f(a: number): number {\n  return a * 2;\n}");
    expect(mutants.find((m) => m.operator === "return-value")?.replacement).toBe("null");
  });

  it("flips increment and decrement", async () => {
    const mutants = await tsMutants("export function f(a: number): number {\n  a++;\n  return a;\n}");
    expect(mutants.find((m) => m.operator === "increment")?.replacement).toContain("--");
  });

  it("does not mutate inside comments", async () => {
    const mutants = await tsMutants("// a > b and a + b\nexport const f = () => 1;");
    expect(mutants.filter((m) => m.line === 1)).toEqual([]);
  });

  it("is diff-only — nothing outside the changed lines", async () => {
    const source = [
      "export const a = (x: number) => x > 1;",
      "export const b = (x: number) => x > 2;",
      "export const c = (x: number) => x > 3;",
    ].join("\n");

    const mutants = await tsMutants(source, new Set([2]));
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.every((m) => m.line === 2)).toBe(true);
  });

  it("generates nothing when no lines changed", async () => {
    expect(await tsMutants("export const f = (a: number) => a > 1;", new Set())).toEqual([]);
  });

  it("returns nothing for an unparseable file rather than throwing", async () => {
    await expect(tsMutants("export function ( { ] ")).resolves.toBeDefined();
  });
});

describe("Python mutant generation", () => {
  it("mutates comparisons, arithmetic, logic and returns", async () => {
    const source = [
      "def f(a, b):",
      "    if a > b and a == 1:",
      '        return "yes"',
      "    return a + b",
    ].join("\n");

    const mutants = await generateMutants("app/m.py", source, {
      changedLines: ALL_LINES,
      pluginRoot: PLUGIN_ROOT,
    });

    const operators = new Set(mutants.map((m) => m.operator));
    expect(operators).toContain("conditional-boundary");
    expect(operators).toContain("negate-conditional");
    expect(operators).toContain("logical");
    expect(operators).toContain("arithmetic");
    expect(operators).toContain("return-value");
  });

  it("is diff-only for Python too", async () => {
    const source = ["def f(a):", "    return a > 1", "", "", "def g(a):", "    return a > 2"].join("\n");
    const mutants = await generateMutants("app/m.py", source, {
      changedLines: new Set([6]),
      pluginRoot: PLUGIN_ROOT,
    });
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.every((m) => m.line === 6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Selection and application
// ---------------------------------------------------------------------------

describe("selection", () => {
  function mutant(file: string, start: number): Mutant {
    return {
      file,
      line: start,
      operator: "arithmetic",
      start,
      end: start + 1,
      replacement: "-",
      original: "+",
    };
  }

  it("is deterministic — the same input yields the same selection", () => {
    const all = Array.from({ length: 100 }, (_, i) => mutant(`f${i % 5}.ts`, i));
    const first = selectMutants(all, 10).map((m) => `${m.file}:${m.start}`);
    const second = selectMutants([...all].reverse(), 10).map((m) => `${m.file}:${m.start}`);
    expect(second).toEqual(first);
  });

  it("returns everything when under the cap", () => {
    const all = Array.from({ length: 5 }, (_, i) => mutant("a.ts", i));
    expect(selectMutants(all, 40)).toHaveLength(5);
  });

  it("spreads the sample across files rather than exhausting the first", () => {
    const all = Array.from({ length: 100 }, (_, i) => mutant(`f${i % 5}.ts`, i));
    const files = new Set(selectMutants(all, 10).map((m) => m.file));
    expect(files.size).toBeGreaterThan(1);
  });

  it("applies a mutant at exactly its range", () => {
    expect(applyMutant("a + b", mutant("a.ts", 2))).toBe("a - b");
  });
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** A repo whose test suite is a single node script, so runs are fast. */
function setupRunnableRepo(testBody: string, sourceBody: string): void {
  repo.write(
    "package.json",
    JSON.stringify({ name: "mut", scripts: { test: "node ./run-tests.mjs" } }, null, 2),
  );
  repo.write("src/calc.ts", sourceBody);
  repo.write("run-tests.mjs", testBody);
  repo.commit("base");
}

/** Test runner that reads the source and asserts on real behaviour. */
const STRONG_TEST = `
import { readFileSync } from "node:fs";
const src = readFileSync("src/calc.ts", "utf8");
// Strip types, then evaluate, so a mutated operator changes the answer.
const js = src.replace(/: number/g, "").replace(/export /g, "");
const fn = new Function(js + "; return add;")();
if (fn(2, 3) !== 5) { console.error("add(2,3) !== 5"); process.exit(1); }
if (fn(0, 0) !== 0) { console.error("add(0,0) !== 0"); process.exit(1); }
`;

/** Tautological runner: executes the code, asserts nothing meaningful. */
const TAUTOLOGICAL_TEST = `
import { readFileSync } from "node:fs";
const src = readFileSync("src/calc.ts", "utf8");
const js = src.replace(/: number/g, "").replace(/export /g, "");
const fn = new Function(js + "; return add;")();
// Calls the function and checks it returned *something*. Coverage: 100%.
if (typeof fn(2, 3) !== "number") process.exit(1);
`;

const SOURCE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

describe("runner", () => {
  it("detects the repo's test command", () => {
    repo.write("package.json", JSON.stringify({ name: "x", scripts: { test: "vitest run" } }));
    expect(resolveTestCommand(repo.root, repo.config())).toBe("npm test");
  });

  it("prefers a configured test command", () => {
    const config = repo.config();
    expect(
      resolveTestCommand(repo.root, { ...config, mutation: { ...config.mutation, test_command: "make t" } }),
    ).toBe("make t");
  });

  it("passes with nothing to mutate", async () => {
    repo.write("package.json", JSON.stringify({ name: "x", scripts: { test: "true" } }));
    repo.write("README.md", "# docs only\n");

    const report = await runMutation({ root: repo.root, pluginRoot: PLUGIN_ROOT, config: repo.config() });
    expect(report.total).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.note).toContain("no mutable changed lines");
  });

  it("kills mutants when the tests assert real behaviour", async () => {
    setupRunnableRepo(STRONG_TEST, SOURCE);
    // Re-touch the file so its lines count as changed.
    repo.write("src/calc.ts", SOURCE.replace("a + b", "a + b "));

    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
    });

    expect(report.total).toBeGreaterThan(0);
    expect(report.killed).toBeGreaterThan(0);
    expect(report.score).toBeGreaterThanOrEqual(0.5);
    expect(report.passed).toBe(true);
  }, 180_000);

  it("catches a tautological test — full coverage, mutants survive", async () => {
    // The exact failure mode the plan names: "tests that restate the
    // implementation... caught by mutation testing, not by review". This test
    // asserts on `typeof result === "number"`, which executes every line and
    // constrains almost nothing.
    setupRunnableRepo(TAUTOLOGICAL_TEST, SOURCE);
    repo.write("src/calc.ts", SOURCE.replace("a + b", "a + b "));

    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
    });

    expect(report.total).toBeGreaterThan(0);
    expect(report.survived).toBeGreaterThan(0);

    // Specifically, swapping `+` for `-` goes unnoticed: the result is still a
    // number, so the assertion still holds while the behaviour is now wrong.
    const survivors = report.results.filter((r) => r.outcome === "survived");
    expect(survivors.some((r) => r.mutant.operator === "arithmetic")).toBe(true);

    // The strong suite kills what this one misses — same source, same mutants.
    expect(report.score).toBeLessThan(1);
  }, 180_000);

  it("fails the gate once the floor is above what a weak suite achieves", async () => {
    // The 50% starting floor is deliberately lenient ("ratcheting quarterly"),
    // so the gate is exercised at the floor a team would ratchet to.
    setupRunnableRepo(TAUTOLOGICAL_TEST, SOURCE);
    repo.write("src/calc.ts", SOURCE.replace("a + b", "a + b "));

    const config = repo.config();
    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: { ...config, mutation: { ...config.mutation, min_score: 0.9 } },
    });

    expect(report.survived).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  }, 180_000);

  it("always restores the file, even after a run that found survivors", async () => {
    setupRunnableRepo(TAUTOLOGICAL_TEST, SOURCE);
    const mutated = SOURCE.replace("a + b", "a + b ");
    repo.write("src/calc.ts", mutated);

    await runMutation({ root: repo.root, pluginRoot: PLUGIN_ROOT, config: repo.config() });

    expect(readFileSync(join(repo.root, "src/calc.ts"), "utf8")).toBe(mutated);
  }, 180_000);

  it("fails fast when the suite is already red", async () => {
    setupRunnableRepo("process.exit(1);", SOURCE);
    repo.write("src/calc.ts", SOURCE.replace("a + b", "a + b "));

    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
    });

    expect(report.passed).toBe(false);
    expect(report.note).toContain("already failing");
  }, 180_000);

  it("reports when no test command can be found", async () => {
    repo.write("src/calc.ts", SOURCE);
    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
    });
    expect(report.note).toContain("no test command");
  });

  it("never mutates test files", async () => {
    repo.write("package.json", JSON.stringify({ name: "x", scripts: { test: "true" } }));
    repo.write("src/thing.test.ts", "it('a', () => { expect(1 + 1).toBe(2); });\n");

    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
    });
    expect(report.total).toBe(0);
  });

  it("never mutates exempt paths", async () => {
    repo.write("package.json", JSON.stringify({ name: "x", scripts: { test: "true" } }));
    repo.write("vite.config.ts", "export default { a: 1 + 1 };\n");

    const report = await runMutation({
      root: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
    });
    expect(report.total).toBe(0);
  });
});
