import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../../src/router/classify.js";
import { collectSignals } from "../../src/router/signals.js";
import { loadTypeScript } from "../../src/shared/ast/ts.js";
import { defaultConfig } from "../../src/shared/config.js";

/**
 * M3 acceptance: "Classification p95 < 150 ms on a 5,000-file repo."
 *
 * Measured, never assumed (definition of done, §4). Two numbers are reported
 * because they answer different questions:
 *
 *   warm — the compiler is already resident. This is the algorithmic cost and
 *          the one the 150 ms budget is about: it must not grow with repo size.
 *   cold — includes the one-off ~400 ms `import('typescript')`. Paid once per
 *          CLI process, never per file.
 */

const PLUGIN_ROOT = resolve(__dirname, "..", "..");
const FILE_COUNT = 5000;
const WARM_BUDGET_MS = 150;

let repo: string;

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "keel-perf-"));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "keel@example.test"]);
  git(repo, ["config", "user.name", "Keel Perf"]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  // A realistic shape: many modules spread over many directories, each with a
  // couple of exports, so `git grep` has real work to do.
  for (let i = 0; i < FILE_COUNT; i++) {
    const dir = `src/mod${Math.floor(i / 50)}`;
    write(
      repo,
      `${dir}/file${i}.ts`,
      [
        `export function helper${i}(value: number): number {`,
        `  return value + ${i};`,
        "}",
        "",
        `export const CONST_${i} = ${i};`,
      ].join("\n"),
    );
  }
  write(repo, ".gitignore", ".keel/\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "5000 files"]);
}, 240_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("router performance", () => {
  it(
    `classifies a change in a ${FILE_COUNT}-file repo within budget`,
    async () => {
      const config = defaultConfig("perf-repo", ["typescript"]);
      const iterations = 12;

      // Cold: first collection in this process, including compiler load.
      write(repo, "src/mod0/file0.ts", "export function helper0(value: number): number {\n  return value + 1;\n}\n\nexport const CONST_0 = 0;");
      const coldStart = process.hrtime.bigint();
      await collectSignals(repo, config, { pluginRoot: PLUGIN_ROOT });
      const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;

      // The compiler is resident from here on.
      await loadTypeScript();

      const warm: number[] = [];
      for (let i = 0; i < iterations; i++) {
        // Vary the content so the content-hashed cache never short-circuits;
        // this measures real work, not cache reads.
        write(
          repo,
          "src/mod0/file0.ts",
          `export function helper0(value: number): number {\n  return value + ${i + 2};\n}\n\nexport const CONST_0 = 0;`,
        );
        rmSync(join(repo, ".keel"), { recursive: true, force: true });

        const start = process.hrtime.bigint();
        const signals = await collectSignals(repo, config, { pluginRoot: PLUGIN_ROOT });
        classify(signals, config);
        warm.push(Number(process.hrtime.bigint() - start) / 1e6);
      }

      const p50 = percentile(warm, 50);
      const p95 = percentile(warm, 95);

      console.log(
        `\n  router perf (${FILE_COUNT} files): warm p50 ${p50.toFixed(1)} ms, ` +
          `warm p95 ${p95.toFixed(1)} ms (budget ${WARM_BUDGET_MS} ms), cold ${coldMs.toFixed(1)} ms\n`,
      );

      expect(p95).toBeLessThan(WARM_BUDGET_MS);
    },
    300_000,
  );
});
