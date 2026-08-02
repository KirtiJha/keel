import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPacks } from "../../src/standards/loader.js";
import { resetRuleCache } from "../../src/standards/rule-loader.js";
import { applicablePacks, formatBlocking, languageOf, runGates } from "../../src/standards/runner.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-runner-");
  resetRuleCache();
});

afterEach(() => {
  repo.dispose();
});

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

    expect(summary.blocking.every((f) => f.pack === "high-pack")).toBe(true);
    expect(summary.advisory.every((f) => f.pack === "medium-pack")).toBe(true);
    expect(summary.advisory.length).toBeGreaterThan(0);
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
