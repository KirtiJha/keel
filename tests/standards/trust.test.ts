import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetRuleCache } from "../../src/standards/rule-loader.js";
import { runGates } from "../../src/standards/runner.js";
import {
  listUntrustedRules,
  resetTrustCache,
  trustRule,
  untrustRule,
} from "../../src/standards/trust.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * Defect 1: a pack rule found in the repository is code, and it used to run
 * with no approval of any kind.
 *
 * `standards.dirs` defaults to `["standards"]`, so cloning an untrusted repo
 * and letting Claude edit one matching file executed that repo's code with the
 * developer's full privileges. Every test here is written against a rule with
 * an *observable side effect at import time* — a marker file — because the
 * question is not "were findings reported" but "did the code run at all".
 */

let repo: TempRepo;
let keelHome: string;

beforeEach(() => {
  repo = TempRepo.create("keel-trust-");
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

function scope() {
  return { repoRoot: repo.root, pluginRoot: PLUGIN_ROOT, config: repo.config() };
}

const MARKER = "pwned.txt";

function markerPath(): string {
  return join(repo.root, MARKER);
}

/** A pack whose rule writes a file the moment it is imported. */
function hostilePack(name = "hostile"): void {
  repo.write(
    `standards/${name}/standard.yaml`,
    [
      `name: ${name}`,
      "mode: gate",
      'applies_to: ["src/**/*.ts"]',
      "languages: [typescript]",
      "owner: whoever-opened-the-pr",
      "severity: high",
      'description: "Runs code on import."',
    ].join("\n"),
  );
  repo.write(
    `standards/${name}/rule.ts`,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(markerPath())}, 'executed');`,
      "import type { Finding, GateContext } from '../../src/standards/types.js';",
      "const rule = (ctx: GateContext): Finding[] =>",
      "  ctx.source.split('\\n').map((_, i) => ({ line: i + 1, message: 'x', fix: 'y' }));",
      "export default rule;",
    ].join("\n"),
  );
}

/** A pack with no side effects, used only to make approvals happen. */
function harmlessPack(name: string): void {
  repo.write(
    `standards/${name}/standard.yaml`,
    [
      `name: ${name}`,
      "mode: gate",
      'applies_to: ["nothing/**/*.ts"]',
      "languages: [typescript]",
      "owner: test-team",
      "severity: low",
      'description: "Does nothing."',
    ].join("\n"),
  );
  repo.write(`standards/${name}/rule.ts`, "const rule = () => [];\nexport default rule;\n");
}

async function check(path = "src/app.ts", source = "const a = 1;\n") {
  repo.write(path, source);
  return runGates({
    repoRoot: repo.root,
    pluginRoot: PLUGIN_ROOT,
    config: repo.config(),
    filePath: path,
  });
}

describe("a repo-local rule does not run until it is approved", () => {
  it("does not execute an unapproved rule, and does not block the edit either", async () => {
    hostilePack();

    const summary = await check();

    expect(existsSync(markerPath()), "the repo's rule must not have executed").toBe(false);
    expect(summary.blocking).toEqual([]);
    expect(summary.health.untrusted).toContain("hostile");
    expect(summary.health.complete).toBe(false);

    const result = summary.results.find((r) => r.pack === "hostile");
    expect(result?.status).toBe("untrusted");
    expect(result?.detail).toContain("never been approved");
    // Nothing ran, so nothing may be reported as an error either.
    expect(result?.error).toBeUndefined();
  });

  it("runs it once a human approves it", async () => {
    hostilePack();
    expect(trustRule(scope(), "hostile").ok).toBe(true);

    const summary = await check();

    expect(existsSync(markerPath())).toBe(true);
    expect(summary.blocking).toHaveLength(1);
    expect(summary.health.untrusted).toEqual([]);
    expect(summary.health.complete).toBe(true);
  });

  it("stops running it again as soon as the rule file changes", async () => {
    hostilePack();
    expect(trustRule(scope(), "hostile").ok).toBe(true);
    await check();
    expect(existsSync(markerPath())).toBe(true);

    // The approval covers the bytes that were approved, not the path.
    rmSync(markerPath());
    repo.write(
      "standards/hostile/rule.ts",
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath())}, 'executed later');`,
        "const rule = () => [];",
        "export default rule;",
      ].join("\n"),
    );
    resetRuleCache();
    resetTrustCache();

    const summary = await check("src/other.ts");

    expect(existsSync(markerPath())).toBe(false);
    const result = summary.results.find((r) => r.pack === "hostile");
    expect(result?.status).toBe("untrusted");
    expect(result?.detail).toContain("changed since it was approved");
  });

  it("ignores a trust record the repository shipped with itself", async () => {
    hostilePack();
    // This machine has approved packs before, so a key exists and the record
    // below is rejected on its signature rather than for want of a key.
    harmlessPack("already-approved");
    expect(trustRule(scope(), "already-approved").ok).toBe(true);

    // The attack the signature exists for: `.keel/` is just a directory, and a
    // hostile repo can commit an approval for its own rule.
    const sha = createHash("sha256")
      .update(readFileSync(join(repo.root, "standards/hostile/rule.ts")))
      .digest("hex");
    repo.write(
      ".keel/trust.json",
      JSON.stringify(
        {
          version: 1,
          rules: [
            {
              pack: "hostile",
              file: "standards/hostile/rule.ts",
              sha256: sha,
              approvedAt: new Date().toISOString(),
              mac: "a".repeat(64),
            },
          ],
        },
        null,
        2,
      ),
    );
    resetTrustCache();

    const summary = await check();

    expect(existsSync(markerPath())).toBe(false);
    const result = summary.results.find((r) => r.pack === "hostile");
    expect(result?.status).toBe("untrusted");
    expect(result?.detail).toContain("not written by this machine");
  });

  it("refuses to run when the approval cannot be verified at all", async () => {
    hostilePack();
    expect(trustRule(scope(), "hostile").ok).toBe(true);

    // The machine key is gone — a restored home directory, another machine, a
    // copied repo. An approval that cannot be checked is not an approval.
    rmSync(keelHome, { recursive: true, force: true });
    resetTrustCache();
    resetRuleCache();

    const summary = await check("src/no-key.ts");

    expect(existsSync(markerPath())).toBe(false);
    expect(summary.results.find((r) => r.pack === "hostile")?.status).toBe("untrusted");
    expect(summary.blocking).toEqual([]);
  });

  it("revokes an approval on request", async () => {
    hostilePack();
    expect(trustRule(scope(), "hostile").ok).toBe(true);
    expect(listUntrustedRules(scope())).toEqual([]);

    const removed = untrustRule(repo.root, "hostile");
    expect(removed.ok && removed.value).toBe(1);
    resetRuleCache();

    const summary = await check("src/after-revoke.ts");
    expect(summary.results.find((r) => r.pack === "hostile")?.status).toBe("untrusted");
  });
});

describe("packs that ship with the plugin", () => {
  it("run without any approval — they arrive with Keel, not with the repo", async () => {
    const summary = await check(
      "src/ui/Card.tsx",
      ["export const styles = {", '  color: "#ff0044",', "};"].join("\n"),
    );

    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.pack).toBe("no-raw-color-values");
    expect(summary.health.complete).toBe(true);
  });

  it("are never listed as needing approval", () => {
    hostilePack();
    const names = listUntrustedRules(scope()).map((r) => r.pack);
    expect(names).toContain("hostile");
    expect(names).not.toContain("no-raw-color-values");
    expect(names).not.toContain("error-envelope");
  });
});

describe("the approval surface the CLI drives", () => {
  it("names the file to read, why it is untrusted, and its hash", () => {
    hostilePack();

    const [entry, ...rest] = listUntrustedRules(scope());
    expect(rest).toEqual([]);
    expect(entry?.pack).toBe("hostile");
    expect(entry?.mode).toBe("gate");
    expect(entry?.owner).toBe("whoever-opened-the-pr");
    expect(entry?.file).toBe("standards/hostile/rule.ts");
    expect(entry?.sha256).toHaveLength(64);
    expect(entry?.changed).toBe(false);
    expect(entry?.reason).toContain("never been approved");
  });

  it("reports a re-approval as a change, not as a first sighting", () => {
    hostilePack();
    expect(trustRule(scope(), "hostile").ok).toBe(true);
    repo.write("standards/hostile/rule.ts", "const rule = () => [];\nexport default rule;\n");
    resetTrustCache();

    const [entry] = listUntrustedRules(scope());
    expect(entry?.changed).toBe(true);
  });

  it("refuses to approve a pack that does not exist, in words a terminal can print", () => {
    const result = trustRule(scope(), "no-such-pack");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("no standards pack named");
  });

  it("refuses to approve a plugin pack, because there is nothing to approve", () => {
    const result = trustRule(scope(), "no-raw-color-values");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("ships with Keel");
  });
});

describe("python rules are gated the same way", () => {
  it("does not hand an unapproved rule.py to the interpreter", async () => {
    repo.write(
      "standards/py-pack/standard.yaml",
      [
        "name: py-pack",
        "mode: gate",
        'applies_to: ["src/**/*.py"]',
        "languages: [python]",
        "owner: test-team",
        "severity: high",
        'description: "Python rule."',
      ].join("\n"),
    );
    repo.write(
      "standards/py-pack/rule.py",
      ["from pathlib import Path", `Path(${JSON.stringify(markerPath())}).write_text("executed")`, "", "def check(ctx):", "    return []", ""].join("\n"),
    );

    const summary = await check("src/thing.py", "x = 1\n");

    expect(existsSync(markerPath())).toBe(false);
    expect(summary.results.find((r) => r.pack === "py-pack")?.status).toBe("untrusted");
    expect(summary.blocking).toEqual([]);
  });
});
