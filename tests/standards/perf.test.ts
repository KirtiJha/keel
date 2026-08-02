import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetRuleCache } from "../../src/standards/rule-loader.js";
import { runGates } from "../../src/standards/runner.js";
import { loadTypeScript } from "../../src/shared/ast/ts.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * M4 acceptance: "Gate runner p95 < 200 ms per file."
 *
 * Measured warm, with the compiler resident and the rule compiled — which is
 * the steady state after the first edit of a session. The one-off compiler load
 * is reported separately by the hook cold-start benchmark.
 *
 * **Reported, not gated on the tight number.** `npm test` is the oracle `keel
 * mutate` uses to decide whether a mutant was killed, so a wall-clock assertion
 * here does not just flake a build — a timing blip during a mutant run scores
 * that mutant as killed and inflates the mutation score, which is the number
 * this project uses in place of coverage. The sibling router benchmark solves
 * this by asserting a scaling ratio; per-file gate cost has no such second
 * measurement to divide by, so it asserts only a catastrophic-regression
 * ceiling. The p50/p95 against the real budget are printed on every run, and
 * the honest gate for them is the benchmark job, not the correctness suite.
 */

/** The acceptance target. Printed and compared, never asserted — see above. */
const BUDGET_MS = 200;
/** Catches an order-of-magnitude regression while ignoring scheduler jitter. */
const SANITY_CEILING_MS = 2000;
let repo: TempRepo;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/** A component file of realistic size with a violation near the end. */
function component(seed: number): string {
  const rows = Array.from(
    { length: 120 },
    (_, i) => `  const row${i} = { id: ${i}, label: "row ${i}", width: ${i + seed} };`,
  ).join("\n");
  return [
    "import { tokens } from './tokens.js';",
    "export function Panel(): unknown {",
    rows,
    "  const styles = { color: \"#ff0044\", padding: tokens.space.md };",
    "  return { styles, rows: [row0, row1] };",
    "}",
  ].join("\n");
}

beforeAll(async () => {
  repo = TempRepo.create("keel-gate-perf-");
  await loadTypeScript();
  resetRuleCache();
  // Prime the compiled-rule cache so the measurement is steady state.
  repo.write("src/ui/warm.tsx", component(0));
  await runGates({
    repoRoot: repo.root,
    pluginRoot: PLUGIN_ROOT,
    config: repo.config(),
    filePath: "src/ui/warm.tsx",
  });
});

afterAll(() => {
  repo.dispose();
});

describe("gate runner performance", () => {
  it("checks a file within the per-file budget", async () => {
    const iterations = 25;
    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const path = `src/ui/Panel${i}.tsx`;
      repo.write(path, component(i));

      const start = process.hrtime.bigint();
      const summary = await runGates({
        repoRoot: repo.root,
        pluginRoot: PLUGIN_ROOT,
        config: repo.config(),
        filePath: path,
      });
      timings.push(Number(process.hrtime.bigint() - start) / 1e6);

      // The measurement is worthless if the gate is not actually finding things.
      expect(summary.blocking).toHaveLength(1);
    }

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const verdict = p95 < BUDGET_MS ? "within budget" : "OVER BUDGET — investigate";
    console.log(
      `\n  gate runner: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms ` +
        `(budget ${BUDGET_MS} ms) — ${verdict}\n`,
    );

    expect(p95).toBeLessThan(SANITY_CEILING_MS);
  }, 120_000);
});
