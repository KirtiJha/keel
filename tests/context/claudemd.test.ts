import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BEGIN_MARKER,
  END_MARKER,
  MAX_MANAGED_LINES,
  generateManagedBlockCapped,
  mergeClaudeMd,
  writeClaudeMd,
} from "../../src/context/claudemd.js";
import { detectCommands, detectLanguages, detectPurpose } from "../../src/context/commands.js";
import type { GotchaCandidate } from "../../src/context/gotchas.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-claudemd-");
});

afterEach(() => {
  repo.dispose();
});

function gotcha(proposed: string): GotchaCandidate {
  return { kind: "warning-comment", path: "src/x.ts", evidence: "e", proposed, confidence: "high" };
}

describe("command detection", () => {
  it("reads npm scripts and uses the form a human would type", () => {
    repo.write(
      "package.json",
      JSON.stringify({ name: "demo", scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }),
    );
    const commands = detectCommands(repo.root);
    expect(commands.build).toBe("npm run build");
    expect(commands.test).toBe("npm test");
    expect(commands.lint).toBe("npm run lint");
  });

  it("respects the declared package manager", () => {
    repo.write(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@9.0.0", scripts: { test: "vitest" } }),
    );
    expect(detectCommands(repo.root).test).toBe("pnpm test");
  });

  it("infers pnpm from a lockfile", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { build: "tsc" } }));
    repo.write("pnpm-lock.yaml", "lockfileVersion: 9");
    expect(detectCommands(repo.root).build).toBe("pnpm build");
  });

  it("detects python tooling from pyproject sections", () => {
    repo.write("pyproject.toml", "[tool.pytest.ini_options]\n\n[tool.ruff]\n\n[tool.mypy]\n");
    const commands = detectCommands(repo.root);
    expect(commands.test).toBe("pytest");
    expect(commands.lint).toBe("ruff check .");
    expect(commands.typecheck).toBe("mypy .");
  });

  it("prefers a Makefile, because that is what the repo put there to be used", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));
    repo.write("Makefile", "test:\n\tpytest\n\nbuild:\n\ttsc\n");
    const commands = detectCommands(repo.root);
    expect(commands.test).toBe("make test");
    expect(commands.build).toBe("make build");
  });

  it("detects languages present", () => {
    repo.write("package.json", "{}");
    repo.write("pyproject.toml", "[project]\nname='x'");
    expect(detectLanguages(repo.root).sort()).toEqual(["python", "typescript"]);
  });

  it("takes the purpose from package.json, then the README", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", description: "Handles payments." }));
    expect(detectPurpose(repo.root)).toBe("Handles payments.");

    repo.write("package.json", JSON.stringify({ name: "demo" }));
    repo.write("README.md", "# Demo\n\n![badge](x)\n\nThe billing service.\n");
    expect(detectPurpose(repo.root)).toBe("The billing service.");
  });
});

describe("managed block", () => {
  it("stays under the 60-line cap even with many gotchas", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", description: "d", scripts: { test: "v" } }));
    const block = generateManagedBlockCapped({
      root: repo.root,
      config: repo.config(),
      confirmedGotchas: Array.from({ length: 200 }, (_, i) => gotcha(`gotcha number ${i}`)),
    });
    expect(block.split("\n").length).toBeLessThanOrEqual(MAX_MANAGED_LINES);
    expect(block).toContain(END_MARKER);
  });

  it("contains exact commands, not framework facts already in config", () => {
    repo.write(
      "package.json",
      JSON.stringify({ name: "demo", description: "A service.", scripts: { test: "vitest run", build: "tsc" } }),
    );
    const block = generateManagedBlockCapped({
      root: repo.root,
      config: repo.config(),
      confirmedGotchas: [],
    });

    expect(block).toContain("`npm test`");
    expect(block).toContain("`npm run build`");
    // The tool behind the script is visible in package.json; do not restate it.
    expect(block).not.toContain("vitest");
    expect(block).not.toContain("tsc");
  });

  it("includes only confirmed gotchas", () => {
    repo.write("package.json", JSON.stringify({ name: "demo" }));
    const block = generateManagedBlockCapped({
      root: repo.root,
      config: repo.config(),
      confirmedGotchas: [gotcha("this one was confirmed by a human")],
    });
    expect(block).toContain("confirmed by a human");
  });

  it("omits the gotchas section entirely when nothing was confirmed", () => {
    repo.write("package.json", JSON.stringify({ name: "demo" }));
    const block = generateManagedBlockCapped({
      root: repo.root,
      config: repo.config(),
      confirmedGotchas: [],
    });
    expect(block).not.toContain("## Gotchas");
  });

  it("is deterministic", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "v" } }));
    const options = { root: repo.root, config: repo.config(), confirmedGotchas: [] };
    expect(generateManagedBlockCapped(options)).toBe(generateManagedBlockCapped(options));
  });
});

describe("merge — idempotence and never clobbering hand edits", () => {
  const managed = `${BEGIN_MARKER}\n# generated\n${END_MARKER}`;

  it("creates the file when none exists", () => {
    expect(mergeClaudeMd(null, managed).action).toBe("created");
  });

  it("appends to a hand-written file that has no markers, keeping every byte", () => {
    const existing = "# My notes\n\nSomething important I wrote.\n";
    const result = mergeClaudeMd(existing, managed);
    expect(result.action).toBe("appended");
    expect(result.content).toContain("Something important I wrote.");
    expect(result.content).toContain(BEGIN_MARKER);
  });

  it("replaces only the managed block, preserving text before and after", () => {
    const existing = `Above the block.\n\n${BEGIN_MARKER}\nold generated content\n${END_MARKER}\n\nBelow the block.\n`;
    const result = mergeClaudeMd(existing, managed);

    expect(result.action).toBe("updated");
    expect(result.content).toContain("Above the block.");
    expect(result.content).toContain("Below the block.");
    expect(result.content).toContain("# generated");
    expect(result.content).not.toContain("old generated content");
  });

  it("reports unchanged when the managed block already matches", () => {
    const existing = `x\n\n${managed}\n\ny\n`;
    expect(mergeClaudeMd(existing, managed).action).toBe("unchanged");
  });

  it("is idempotent across repeated writes", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "v" } }));
    const options = { root: repo.root, config: repo.config(), confirmedGotchas: [] };

    expect(writeClaudeMd(options).action).toBe("created");
    expect(writeClaudeMd(options).action).toBe("unchanged");
    expect(writeClaudeMd(options).action).toBe("unchanged");
  });

  it("survives a hand edit outside the markers across a regeneration", () => {
    repo.write("package.json", JSON.stringify({ name: "demo", scripts: { test: "v" } }));
    const options = { root: repo.root, config: repo.config(), confirmedGotchas: [] };
    writeClaudeMd(options);

    const path = `${repo.root}/CLAUDE.md`;
    repo.write("CLAUDE.md", `${readFileSync(path, "utf8")}\n## Team notes\n\nDo not lose this.\n`);

    writeClaudeMd({ ...options, confirmedGotchas: [gotcha("a newly confirmed gotcha")] });

    const after = readFileSync(path, "utf8");
    expect(after).toContain("Do not lose this.");
    expect(after).toContain("a newly confirmed gotcha");
  });
});

describe("M5 acceptance — run against this repo", () => {
  it("generates a block under 60 lines with this repo's real commands", () => {
    const block = generateManagedBlockCapped({
      root: PLUGIN_ROOT,
      config: repo.config(),
      confirmedGotchas: [],
    });

    expect(block.split("\n").length).toBeLessThanOrEqual(MAX_MANAGED_LINES);
    expect(block).toContain("`npm test`");
    expect(block).toContain("`npm run build`");
  });
});
