import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../../src/router/classify.js";
import { collectSignals } from "../../src/router/signals.js";
import { defaultConfig, type KeelConfig } from "../../src/shared/config.js";

import { BASE_FILES, ROUTER_FIXTURES } from "./fixtures.js";

const PLUGIN_ROOT = resolve(__dirname, "..", "..");

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

let repo: string;

function routerConfig(): KeelConfig {
  const base = defaultConfig("fixture-repo", ["typescript", "python"]);
  return {
    ...base,
    router: {
      ...base.router,
      force_full_globs: ["**/migrations/**", "**/auth/**", "openapi/**"],
    },
  };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "keel-router-"));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "keel@example.test"]);
  git(repo, ["config", "user.name", "Keel Fixtures"]);
  git(repo, ["config", "commit.gpgsign", "false"]);

  for (const [path, content] of Object.entries(BASE_FILES)) write(repo, path, content);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "base"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Return the working tree to the committed baseline. */
function resetRepo(): void {
  git(repo, ["checkout", "--quiet", "--", "."]);
  git(repo, ["clean", "-qfd"]);
  rmSync(join(repo, ".keel"), { recursive: true, force: true });
}

describe("router fixture suite", () => {
  it("covers at least 30 diffs, as the acceptance criteria require", () => {
    expect(ROUTER_FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  for (const fixture of ROUTER_FIXTURES) {
    it(`${fixture.name} -> ${fixture.expected}`, async () => {
      resetRepo();

      for (const [path, content] of Object.entries(fixture.change)) {
        if (content === null) rmSync(join(repo, path), { force: true });
        else write(repo, path, content);
      }

      const config = routerConfig();
      const signals = await collectSignals(repo, config, { pluginRoot: PLUGIN_ROOT });
      const result = classify(signals, config);

      expect(
        result.track,
        `${fixture.name}: expected ${fixture.expected} because ${fixture.because}. ` +
          `Got ${result.track}. Reasons: ${result.reasons.join(" | ")}`,
      ).toBe(fixture.expected);
    });
  }
});

describe("signal collection", () => {
  it("detects a real cross-package caller count from git grep", async () => {
    resetRepo();
    write(
      repo,
      "packages/core/src/money.ts",
      "export function toCents(amount: number, currency: string): number {\n  return Math.round(amount * 100) + currency.length * 0;\n}\n\nexport function fromCents(cents: number): number {\n  return cents / 100;\n}",
    );

    const signals = await collectSignals(repo, routerConfig(), { pluginRoot: PLUGIN_ROOT });
    const toCents = signals.changedExportedSymbols.find((s) => s.name === "toCents");

    expect(toCents).toBeDefined();
    expect(toCents?.change).toBe("signature-changed");
    expect(toCents?.externalCallers).toBeGreaterThanOrEqual(7);
    expect(toCents?.crossesPackageBoundary).toBe(true);
  });

  it("counts added and removed lines from the real diff", async () => {
    resetRepo();
    write(repo, "src/logger.ts", "export function logLine(message: string): void {\n  process.stdout.write(message);\n}");

    const signals = await collectSignals(repo, routerConfig(), { pluginRoot: PLUGIN_ROOT });
    expect(signals.changedFiles).toContain("src/logger.ts");
    expect(signals.addedLines).toBeGreaterThan(0);
    expect(signals.removedLines).toBeGreaterThan(0);
  });

  it("treats an untracked file as fully added", async () => {
    resetRepo();
    write(repo, "src/brand-new.ts", "export const answer = 42;\n");

    const signals = await collectSignals(repo, routerConfig(), { pluginRoot: PLUGIN_ROOT });
    expect(signals.changedFiles).toContain("src/brand-new.ts");
    expect(signals.changedExportedSymbols.some((s) => s.name === "answer")).toBe(true);
  });

  it("is cached by content hash — a repeated collection agrees exactly", async () => {
    resetRepo();
    write(repo, "src/util.ts", "export function slugify(a: string, b: string): string {\n  return a + b;\n}");

    const config = routerConfig();
    const first = await collectSignals(repo, config, { pluginRoot: PLUGIN_ROOT });
    const second = await collectSignals(repo, config, { pluginRoot: PLUGIN_ROOT });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
