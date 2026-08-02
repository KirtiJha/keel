import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetRuleCache } from "../../src/standards/rule-loader.js";
import { runGates } from "../../src/standards/runner.js";
import { resetTrustCache, trustRule } from "../../src/standards/trust.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * Defect 2: the compiled-rule cache was trusted on its filename alone.
 *
 * The key was `sha256(rule.ts)` but the *bytes* under that key were never
 * checked against the source they claimed to come from, so `isFile(path)` was
 * the whole verification. Two things fell out of that, both reproduced here:
 * a repo could commit an artifact and have it imported instead of its own
 * reviewed `rule.ts`, and a corrupt artifact disabled the gate permanently
 * while the hook went on reporting success.
 */

let repo: TempRepo;
let keelHome: string;

beforeEach(() => {
  repo = TempRepo.create("keel-rule-cache-");
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

const MARKER = "pwned.txt";

function markerPath(): string {
  return join(repo.root, MARKER);
}

const CACHE_DIR = ".keel/cache/packs";

function cachedArtifacts(pack = ""): string[] {
  try {
    return readdirSync(join(repo.root, CACHE_DIR)).filter(
      (f) => f.endsWith(".mjs") && f.startsWith(pack),
    );
  } catch {
    return [];
  }
}

/** The single cached artifact for the `real` pack, as a repo-absolute path. */
function realArtifact(): string {
  const [name, ...rest] = cachedArtifacts("real-");
  expect(name, "the rule should have been compiled and cached").toBeDefined();
  expect(rest).toEqual([]);
  return join(repo.root, CACHE_DIR, name ?? "");
}

/** An approved, well-behaved pack: one finding per line. */
function realPack(): void {
  repo.write(
    "standards/real/standard.yaml",
    [
      "name: real",
      "mode: gate",
      'applies_to: ["src/**/*.ts"]',
      "languages: [typescript]",
      "owner: test-team",
      "severity: high",
      'description: "Reports on every line."',
    ].join("\n"),
  );
  repo.write(
    "standards/real/rule.ts",
    [
      "import type { Finding, GateContext } from '../../src/standards/types.js';",
      "const rule = (ctx: GateContext): Finding[] =>",
      "  ctx.source.split('\\n').filter((l) => l !== '').map((_, i) => ({",
      "    line: i + 1,",
      "    message: 'the reviewed rule ran',",
      "    fix: 'do something else',",
      "  }));",
      "export default rule;",
    ].join("\n"),
  );
  const trusted = trustRule(
    { repoRoot: repo.root, pluginRoot: PLUGIN_ROOT, config: repo.config() },
    "real",
  );
  if (!trusted.ok) throw new Error(trusted.error);
}

async function check(path: string) {
  repo.write(path, "const a = 1;\n");
  return runGates({
    repoRoot: repo.root,
    pluginRoot: PLUGIN_ROOT,
    config: repo.config(),
    filePath: path,
  });
}

describe("a cached artifact is only used when it verifies", () => {
  it("does not import an artifact the repository planted under the right name", async () => {
    realPack();

    // Warm the cache so the attacker's filename is known to be the one that
    // would be hit. A repo can compute it from its own `rule.ts`.
    await check("src/first.ts");

    // Now overwrite it, exactly as committing `.keel/cache/packs/<name>` does.
    // The `rule.ts` a reviewer reads is unchanged and still says what it said.
    writeFileSync(
      realArtifact(),
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath())}, 'executed');`,
        "const rule = () => [];",
        "export default rule;",
        "",
      ].join("\n"),
      "utf8",
    );
    resetRuleCache();

    const summary = await check("src/second.ts");

    expect(existsSync(markerPath()), "the planted artifact must not be imported").toBe(false);
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.message).toContain("the reviewed rule ran");
  });

  it("keeps out a planted artifact that carries a well-formed stamp of its own", async () => {
    realPack();
    await check("src/first.ts");
    const path = realArtifact();
    const stamp = readFileSync(path, "utf8").split("\n")[0] ?? "";

    // Copying the stamp off a legitimate artifact does not help: it is an HMAC
    // over the body too, under a key that never leaves this machine.
    writeFileSync(
      path,
      [
        stamp,
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(markerPath())}, 'executed');`,
        "const rule = () => [];",
        "export default rule;",
        "",
      ].join("\n"),
      "utf8",
    );
    resetRuleCache();

    const summary = await check("src/second.ts");

    expect(existsSync(markerPath())).toBe(false);
    expect(summary.blocking[0]?.message).toContain("the reviewed rule ran");
  });

  it("regenerates a corrupt artifact instead of failing forever", async () => {
    realPack();
    await check("src/first.ts");
    const path = realArtifact();

    // A truncated write: the artifact is broken, and its key is the hash of a
    // source that has not changed, so it would never have been rewritten.
    writeFileSync(path, "this is not javascript {{{", "utf8");
    resetRuleCache();

    const summary = await check("src/second.ts");

    expect(summary.results.find((r) => r.pack === "real")?.status).toBe("ok");
    expect(summary.results.find((r) => r.pack === "real")?.error).toBeUndefined();
    expect(summary.blocking).toHaveLength(1);
    // And the artifact on disk is a working one again.
    expect(readFileSync(path, "utf8")).toContain("the reviewed rule ran");
  });

  it("still runs the gate when the cache cannot be written", async () => {
    realPack();
    // A file where the cache directory should be: every write will fail. The
    // gate must degrade to compiling in memory, not to not running.
    mkdirSync(join(repo.root, ".keel", "cache"), { recursive: true });
    writeFileSync(join(repo.root, CACHE_DIR), "not a directory", "utf8");

    const summary = await check("src/only.ts");

    expect(summary.results.find((r) => r.pack === "real")?.status).toBe("ok");
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.message).toContain("the reviewed rule ran");
  });
});
