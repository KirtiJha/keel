import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPacks } from "../../src/standards/loader.js";
import { resetRuleCache } from "../../src/standards/rule-loader.js";
import {
  MAX_BLOCKING_CHARS,
  MAX_GATED_FILE_CHARS,
  MAX_RENDERED_FINDINGS,
  applicablePacks,
  formatBlocking,
  languageOf,
  runGates,
} from "../../src/standards/runner.js";
import { resetTrustCache, trustRule } from "../../src/standards/trust.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;
let keelHome: string;

beforeEach(() => {
  repo = TempRepo.create("keel-runner-");
  // Approvals are signed with a machine-local key; keep it out of the
  // developer's real home directory.
  keelHome = mkdtempSync(join(tmpdir(), "keel-home-"));
  process.env["KEEL_HOME"] = keelHome;
  resetRuleCache();
  resetTrustCache();
});

afterEach(() => {
  repo.dispose();
  rmSync(keelHome, { recursive: true, force: true });
  delete process.env["KEEL_HOME"];
});

/**
 * Approve a repo-local pack, as `keel trust` does.
 *
 * Repo-local rules are code the repository supplies, and they do not run until
 * a human says so — see `src/standards/trust.ts`. Every fixture pack below is
 * therefore approved before it is expected to fire.
 */
function trust(name: string): void {
  const result = trustRule(
    { repoRoot: repo.root, pluginRoot: PLUGIN_ROOT, config: repo.config() },
    name,
  );
  if (!result.ok) throw new Error(result.error);
}

/** A pack that reports a finding on every line, so filtering is observable. */
function everyLinePack(name: string, severity = "high"): void {
  repo.write(
    `standards/${name}/standard.yaml`,
    [
      `name: ${name}`,
      "mode: gate",
      'applies_to: ["src/**/*.ts"]',
      "languages: [typescript]",
      "owner: test-team",
      `severity: ${severity}`,
      'description: "Reports on every line."',
    ].join("\n"),
  );
  repo.write(
    `standards/${name}/rule.ts`,
    [
      "import type { Finding, GateContext } from '../../src/standards/types.js';",
      "const rule = (ctx: GateContext): Finding[] =>",
      "  ctx.source.split('\\n').map((_, i) => ({",
      "    line: i + 1,",
      "    message: 'line ' + (i + 1),",
      "    fix: 'do something else',",
      "  }));",
      "export default rule;",
    ].join("\n"),
  );
  trust(name);
}

describe("language detection", () => {
  it("maps extensions to configured languages", () => {
    expect(languageOf("a/b.ts")).toBe("typescript");
    expect(languageOf("a/b.tsx")).toBe("typescript");
    expect(languageOf("a/b.py")).toBe("python");
    expect(languageOf("a/b.md")).toBeNull();
  });
});

describe("applicability", () => {
  it("matches on mode, globs and language together", () => {
    const packs = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).packs;

    expect(applicablePacks(packs, "src/ui/Button.tsx", "gate").map((p) => p.standard.name)).toContain(
      "no-raw-color-values",
    );
    // error-envelope applies to handlers only.
    expect(applicablePacks(packs, "src/ui/Button.tsx", "gate").map((p) => p.standard.name)).not.toContain(
      "error-envelope",
    );
    expect(
      applicablePacks(packs, "services/api/handlers/charge.ts", "gate").map((p) => p.standard.name),
    ).toContain("error-envelope");
  });

  it("does not run a typescript-only pack against a python file", () => {
    const packs = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).packs;
    const names = applicablePacks(packs, "services/api/handlers/charge.py", "gate").map(
      (p) => p.standard.name,
    );
    expect(names).not.toContain("no-raw-color-values");
    expect(names).toContain("error-envelope");
  });
});

describe("diff-only enforcement", () => {
  it("drops findings on lines the change did not touch", async () => {
    everyLinePack("every-line");
    repo.writeCommitted("src/app.ts", ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n"));

    // Touch line 2 only.
    repo.write("src/app.ts", ["const a = 1;", "const b = 22;", "const c = 3;", "const d = 4;"].join("\n"));

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/app.ts",
    });

    expect(summary.blocking.map((f) => f.line)).toEqual([2]);
  });

  it("reports on every line of a brand-new untracked file", async () => {
    everyLinePack("every-line");
    repo.write("src/fresh.ts", ["const a = 1;", "const b = 2;"].join("\n"));

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.blocking.length).toBeGreaterThanOrEqual(2);
  });

  it("reports nothing when the file is unchanged, however dirty it is", async () => {
    everyLinePack("every-line");
    repo.writeCommitted("src/app.ts", ["const a = 1;", "const b = 2;"].join("\n"));

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/app.ts",
    });

    expect(summary.blocking).toEqual([]);
  });

  it("cannot be bypassed by a rule that reports out-of-range lines", async () => {
    repo.write(
      "standards/liar/standard.yaml",
      [
        "name: liar",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Reports impossible lines."',
      ].join("\n"),
    );
    repo.write(
      "standards/liar/rule.ts",
      [
        "import type { Finding } from '../../src/standards/types.js';",
        "const rule = (): Finding[] => [",
        "  { line: 0, message: 'zero', fix: 'x' },",
        "  { line: -5, message: 'negative', fix: 'x' },",
        "  { line: 9999, message: 'past the end', fix: 'x' },",
        "];",
        "export default rule;",
      ].join("\n"),
    );
    trust("liar");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.blocking).toEqual([]);
  });
});

describe("severity", () => {
  it("routes high to blocking and medium to advisory", async () => {
    everyLinePack("high-pack", "high");
    everyLinePack("medium-pack", "medium");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    // `every` on an empty array is vacuously true, so assert the arrays are
    // non-empty first — otherwise "high findings block" passes just as happily
    // when nothing blocked at all.
    expect(summary.blocking.length).toBeGreaterThan(0);
    expect(summary.advisory.length).toBeGreaterThan(0);
    expect(summary.blocking.every((f) => f.pack === "high-pack")).toBe(true);
    expect(summary.advisory.every((f) => f.pack === "medium-pack")).toBe(true);
  });
});

describe("failure modes", () => {
  it("a rule that throws reports an error and does not block the edit", async () => {
    repo.write(
      "standards/thrower/standard.yaml",
      [
        "name: thrower",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Throws."',
      ].join("\n"),
    );
    repo.write(
      "standards/thrower/rule.ts",
      "const rule = () => { throw new Error('boom'); };\nexport default rule;\n",
    );
    trust("thrower");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.blocking).toEqual([]);
    expect(summary.results.find((r) => r.pack === "thrower")?.error).toContain("boom");
  });

  it("a rule that does not compile reports an error and does not block", async () => {
    repo.write(
      "standards/broken-rule/standard.yaml",
      [
        "name: broken-rule",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Does not export a rule."',
      ].join("\n"),
    );
    repo.write("standards/broken-rule/rule.ts", "export const notARule = 42;\n");
    trust("broken-rule");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.blocking).toEqual([]);
    expect(summary.results.find((r) => r.pack === "broken-rule")?.error).toBeDefined();
  });

  it("a missing file yields an empty summary rather than throwing", async () => {
    await expect(
      runGates({
        repoRoot: repo.root,
        pluginRoot: PLUGIN_ROOT,
        config: repo.config(),
        filePath: "src/does-not-exist.ts",
      }),
    ).resolves.toMatchObject({ blocking: [], advisory: [] });
  });
});

/**
 * Defect 3: a pack that errored used to be indistinguishable from a pack that
 * passed. The hook recorded a tick whenever `results.length > 0`, so a dead
 * gate reported success on every edit it should have been checking.
 */
describe("a dead gate is not a passing gate", () => {
  it("separates a rule that failed from a rule that ran", async () => {
    everyLinePack("works", "low");
    repo.write(
      "standards/thrower/standard.yaml",
      [
        "name: thrower",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Throws."',
      ].join("\n"),
    );
    repo.write(
      "standards/thrower/rule.ts",
      "const rule = () => { throw new Error('boom'); };\nexport default rule;\n",
    );
    trust("thrower");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.health.errored).toEqual(["thrower"]);
    expect(summary.health.ran).toContain("works");
    expect(summary.health.complete).toBe(false);
    expect(summary.health.detail).toContain("thrower");
    // And the edit still goes through: a broken pack blocks nobody.
    expect(summary.blocking).toEqual([]);
  });

  it("reports a clean run as complete, with nothing to explain", async () => {
    everyLinePack("every-line");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.health.complete).toBe(true);
    expect(summary.health.detail).toBe("");
    expect(summary.health.ran).toContain("every-line");
  });
});

/**
 * Defect 5: `RULE_TIMEOUT_MS` bounds one rule, and packs are awaited in
 * sequence, so nothing bounded the sum. Twenty packs each returning a promise
 * that never settles ran the hook for 40.9 s against a registered 30 s timeout.
 */
describe("the whole run is bounded, not just each rule", () => {
  function spinnerPack(name: string): void {
    repo.write(
      `standards/${name}/standard.yaml`,
      [
        `name: ${name}`,
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Never resolves."',
      ].join("\n"),
    );
    repo.write(
      `standards/${name}/rule.ts`,
      "const rule = () => new Promise<[]>(() => undefined);\nexport default rule;\n",
    );
    trust(name);
  }

  it("stops starting packs once the budget is gone, and says which it skipped", async () => {
    for (const name of ["spin-a", "spin-b", "spin-c", "spin-d", "spin-e"]) spinnerPack(name);
    repo.write("src/fresh.ts", "const a = 1;\n");

    const started = Date.now();
    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
      budgetMs: 400,
    });
    const elapsed = Date.now() - started;

    // Five packs at the 2 s per-rule timeout would be 10 s.
    expect(elapsed).toBeLessThan(3000);
    expect(summary.health.skipped.length).toBeGreaterThanOrEqual(3);
    expect(summary.health.complete).toBe(false);
    expect(summary.health.detail).toContain("skipped");
    expect(summary.blocking).toEqual([]);

    const skipped = summary.results.find((r) => r.status === "skipped");
    expect(skipped?.detail).toContain("budget");
  }, 30_000);
});

/**
 * Defect 4: `formatBlocking` rendered every finding, and this text is stderr
 * from a PostToolUse hook — it goes straight into the model's context. One edit
 * to an 18 MB file produced 146 KB of it.
 */
describe("blocking output is bounded", () => {
  it("caps how many findings it renders and says how many it dropped", async () => {
    everyLinePack("every-line");
    repo.write("src/fresh.ts", Array.from({ length: 400 }, (_, i) => `const a${i} = ${i};`).join("\n"));

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });
    expect(summary.blocking.length).toBeGreaterThan(300);

    const text = formatBlocking(summary);
    const rendered = text.split("\n").filter((l) => l.includes("[every-line]")).length;

    expect(rendered).toBeLessThanOrEqual(MAX_RENDERED_FINDINGS);
    expect(text.length).toBeLessThanOrEqual(MAX_BLOCKING_CHARS + 1000);
    expect(text).toContain(`…and ${summary.blocking.length - rendered} more findings not shown.`);
    // Truncated or not, it still says what a gate message has to say.
    expect(text).toContain("src/fresh.ts:1");
    expect(text).toContain("fix: do something else");
  });

  it("clips a single enormous message rather than passing it through", async () => {
    repo.write(
      "standards/verbose/standard.yaml",
      [
        "name: verbose",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Says far too much."',
      ].join("\n"),
    );
    repo.write(
      "standards/verbose/rule.ts",
      [
        "import type { Finding } from '../../src/standards/types.js';",
        "const rule = (): Finding[] => [",
        "  { line: 1, message: 'x'.repeat(50000), fix: 'y'.repeat(50000) },",
        "];",
        "export default rule;",
      ].join("\n"),
    );
    trust("verbose");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    expect(summary.blocking).toHaveLength(1);
    expect(formatBlocking(summary).length).toBeLessThan(2000);
  });

  it("does not parse or check a file far larger than any source file", async () => {
    everyLinePack("every-line");
    const huge = `${Array.from({ length: 40_000 }, (_, i) => `const a${i} = ${i};`).join("\n")}\n`;
    expect(huge.length).toBeGreaterThan(MAX_GATED_FILE_CHARS);
    repo.write("src/huge.ts", huge);

    const started = Date.now();
    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/huge.ts",
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(summary.blocking).toEqual([]);
    expect(summary.results).toEqual([]);
    expect(summary.health.skipped).toContain("every-line");
  });
});

describe("blocking message", () => {
  it("names file, line, rule and fix", async () => {
    everyLinePack("every-line");
    repo.write("src/fresh.ts", "const a = 1;\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/fresh.ts",
    });

    const text = formatBlocking(summary);
    expect(text).toContain("src/fresh.ts:1");
    expect(text).toContain("[every-line]");
    expect(text).toContain("fix: do something else");
  });
});

describe("M4 acceptance — a new pack is a folder plus a PR", () => {
  it("fires a brand-new pack dropped into a directory, with zero changes to src/", async () => {
    // Nothing about this pack is known to the codebase: new name, new rule,
    // new config key. If this passes, adding a standard needs no code change.
    repo.write(
      "standards/no-console-log/standard.yaml",
      [
        "name: no-console-log",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: some-new-team",
        "severity: high",
        'description: "No console.log in shipped code."',
        "config:",
        "  banned_callee: console.log",
      ].join("\n"),
    );
    repo.write(
      "standards/no-console-log/rule.ts",
      [
        "import type { Finding, GateContext } from '../../src/standards/types.js';",
        "const rule = (ctx: GateContext): Finding[] => {",
        "  const parsed = ctx.ast;",
        "  if (parsed === null) return [];",
        "  const banned = String(ctx.config['banned_callee'] ?? 'console.log');",
        "  const findings: Finding[] = [];",
        "  const visit = (node: any): void => {",
        "    if (parsed.ts.isCallExpression(node)) {",
        "      const callee = node.expression.getText(parsed.sourceFile);",
        "      if (callee === banned) {",
        "        findings.push({",
        "          line: parsed.lineOf(node.getStart(parsed.sourceFile)),",
        "          message: banned + ' left in shipped code',",
        "          fix: 'use the structured logger',",
        "        });",
        "      }",
        "    }",
        "    node.forEachChild(visit);",
        "  };",
        "  visit(parsed.sourceFile);",
        "  return findings;",
        "};",
        "export default rule;",
      ].join("\n"),
    );
    // The one step that is not "a folder plus a PR": someone with the repo open
    // approves the rule once. Code the repo supplies does not run unasked.
    trust("no-console-log");

    repo.write("src/thing.ts", "export function go(): void {\n  console.log('hi');\n}\n");

    const summary = await runGates({
      repoRoot: repo.root,
      pluginRoot: PLUGIN_ROOT,
      config: repo.config(),
      filePath: "src/thing.ts",
    });

    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.pack).toBe("no-console-log");
    expect(summary.blocking[0]?.line).toBe(2);
    expect(summary.blocking[0]?.fix).toContain("structured logger");
  });
});
