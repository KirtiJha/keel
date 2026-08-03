import { readFileSync } from "node:fs";
import { join } from "node:path";


import { isFile } from "../shared/paths.js";

/**
 * Detect a repo's real build and test commands.
 *
 * M5 requires *exact* commands in the generated CLAUDE.md, and requires that
 * nothing already visible in a config file is restated. Those pull in opposite
 * directions, and the resolution is: emit the command a human would type
 * (`npm test`), never the framework fact behind it ("uses vitest") — the model
 * can read package.json for the latter, but it cannot guess whether this repo
 * is npm, pnpm, make or just.
 */

export interface DetectedCommands {
  readonly install?: string;
  readonly build?: string;
  readonly test?: string;
  readonly lint?: string;
  readonly typecheck?: string;
  readonly run?: string;
  /**
   * A polyglot repo has two commands for one role. The one that did not win the
   * bare key survives here as `<role>:python`, so neither language's suite goes
   * unmentioned. See `displace` below for why that matters.
   */
  readonly [role: string]: string | undefined;
}

interface PackageJson {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly packageManager?: unknown;
}

function readJson(path: string): PackageJson | null {
  if (!isFile(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

/** npm / pnpm / yarn / bun, from packageManager or a lockfile. */
export function detectNodeRunner(root: string, pkg: PackageJson | null): string {
  const declared = pkg?.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") return name;
  }
  if (isFile(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (isFile(join(root, "yarn.lock"))) return "yarn";
  if (isFile(join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function nodeCommand(runner: string, script: string): string {
  // `npm run test` works, but nobody types it; match what a human would run.
  if (script === "test" && runner === "npm") return "npm test";
  if (runner === "npm") return `npm run ${script}`;
  return `${runner} ${script}`;
}

/** Parse a Makefile's target names. */
function makeTargets(root: string): Set<string> {
  const path = join(root, "Makefile");
  if (!isFile(path)) return new Set();
  try {
    const targets = new Set<string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^([A-Za-z0-9_-]+)\s*:(?!=)/.exec(line);
      if (match?.[1] !== undefined) targets.add(match[1]);
    }
    return targets;
  } catch {
    return new Set();
  }
}

function pythonCommands(root: string): Record<string, string> {
  const path = join(root, "pyproject.toml");
  if (!isFile(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  const out: Record<string, string> = {};
  // Presence of a tool's config section is what tells us the command exists.
  if (text.includes("[tool.pytest")) out["test"] = "pytest";
  if (text.includes("[tool.ruff")) out["lint"] = "ruff check .";
  if (text.includes("[tool.mypy")) out["typecheck"] = "mypy .";
  if (isFile(join(root, "uv.lock"))) out["install"] = "uv sync";
  else if (isFile(join(root, "poetry.lock"))) out["install"] = "poetry install";
  return out;
}

/**
 * Commands for a repo, preferring the most specific source.
 *
 * Precedence is Makefile > package.json > pyproject.toml: a repo with a
 * Makefile has usually put it there precisely so nobody has to remember the
 * underlying invocation.
 */
export function detectCommands(root: string): DetectedCommands {
  const pkg = readJson(join(root, "package.json"));
  const runner = detectNodeRunner(root, pkg);
  const scripts = pkg?.scripts ?? {};
  const targets = makeTargets(root);
  const python = pythonCommands(root);

  const out: Record<string, string> = { ...python };

  /**
   * A polyglot repo has two commands for one role, and this map is keyed by
   * role. It used to spread the Python commands and then let the npm scripts
   * overwrite them, so a TypeScript + Python repo produced a CLAUDE.md listing
   * only `npm test` — and the model would run it, see it pass, and report a
   * green suite having executed no Python tests at all. The config sitting
   * beside it said `languages: [typescript, python]`, which made the omission
   * read as deliberate.
   *
   * Both survive now: the displaced one keeps the role under a suffixed key,
   * and CLAUDE.md renders it as its own line. Whichever language "wins" the
   * bare key is a presentation detail; losing one entirely was not.
   */
  const displace = (key: string, incoming: string): void => {
    const existing = out[key];
    if (existing !== undefined && existing !== incoming) out[`${key}:python`] = existing;
    out[key] = incoming;
  };

  const fromScripts = (key: string, candidates: readonly string[]): void => {
    for (const candidate of candidates) {
      if (typeof scripts[candidate] === "string") {
        displace(key, nodeCommand(runner, candidate));
        return;
      }
    }
  };

  fromScripts("build", ["build", "compile"]);
  fromScripts("test", ["test"]);
  fromScripts("lint", ["lint"]);
  fromScripts("typecheck", ["typecheck", "types", "tsc"]);
  fromScripts("run", ["dev", "start"]);
  if (pkg !== null && out["install"] === undefined) {
    out["install"] = runner === "npm" ? "npm install" : `${runner} install`;
  }

  for (const [key, target] of [
    ["build", "build"],
    ["test", "test"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["install", "install"],
    ["run", "run"],
  ] as const) {
    if (targets.has(target)) displace(key, `make ${target}`);
  }

  return out;
}

/** One-line repo purpose, from package.json or the README's first prose line. */
export function detectPurpose(root: string): string | null {
  const pkg = readJson(join(root, "package.json"));
  if (typeof pkg?.description === "string" && pkg.description.trim() !== "") {
    return pkg.description.trim();
  }

  const pyproject = join(root, "pyproject.toml");
  if (isFile(pyproject)) {
    try {
      const match = /^description\s*=\s*["'](.+)["']/m.exec(readFileSync(pyproject, "utf8"));
      if (match?.[1] !== undefined) return match[1].trim();
    } catch {
      // Fall through to the README.
    }
  }

  const readme = join(root, "README.md");
  if (isFile(readme)) {
    try {
      for (const line of readFileSync(readme, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("![")) continue;
        return trimmed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Languages present, used to seed `repo.languages` at init. */
export function detectLanguages(root: string): Array<"typescript" | "python"> {
  const out: Array<"typescript" | "python"> = [];
  if (isFile(join(root, "package.json")) || isFile(join(root, "tsconfig.json"))) out.push("typescript");
  if (
    isFile(join(root, "pyproject.toml")) ||
    isFile(join(root, "setup.py")) ||
    isFile(join(root, "requirements.txt"))
  ) {
    out.push("python");
  }
  return out.length > 0 ? out : ["typescript"];
}
