import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * Hook failure modes (definition of done, §4): malformed stdin, missing config,
 * crash, and a hostile payload.
 *
 * These run the **real bundles** as subprocesses, because that is the only way
 * to test the thing that actually matters — the exit code. Constraint 0.3 says
 * a crashed hook must never break a session, and constraint 0.4 says only exit
 * 2 blocks. Both are properties of the process, not of a function.
 */

const HOOKS = [
  "session-start",
  "pre-tool-use",
  "post-tool-use",
  "post-bash",
  "message-display",
  "session-end",
] as const;

function bundle(name: string): string {
  return join(PLUGIN_ROOT, "scripts", `${name}.mjs`);
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(name: string, input: string, cwd?: string): RunResult {
  const result = spawnSync(process.execPath, [bundle(name)], {
    input,
    encoding: "utf8",
    timeout: 20_000,
    cwd: cwd ?? PLUGIN_ROOT,
    env: { ...process.env, KEEL_SESSION_ID: "failure-modes" },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let repo: TempRepo;

beforeAll(() => {
  // The bundles must exist; `npm run verify` builds before testing.
  for (const name of HOOKS) {
    if (!existsSync(bundle(name))) {
      throw new Error(`missing bundle ${name}.mjs — run \`npm run build\` first`);
    }
  }
});

beforeEach(() => {
  repo = TempRepo.create("keel-hook-");
});

afterEach(() => {
  repo.dispose();
});

describe("malformed stdin", () => {
  const MALFORMED = [
    ["empty", ""],
    ["whitespace", "   \n  "],
    ["not json", "this is not json at all"],
    ["truncated json", '{"hook_event_name": "PreToolUse"'],
    ["json array", "[1, 2, 3]"],
    ["json null", "null"],
    ["json string", '"hello"'],
    ["deeply nested", `{"a":${"[".repeat(200)}${"]".repeat(200)}}`],
    ["huge payload", JSON.stringify({ message: "x".repeat(2_000_000) })],
  ] as const;

  for (const hook of HOOKS) {
    for (const [label, input] of MALFORMED) {
      it(`${hook} exits 0 on ${label}`, () => {
        const result = runHook(hook, input);
        expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      });
    }
  }
});

describe("exit code discipline", () => {
  it("every hook emits valid JSON on stdout when it proceeds", () => {
    for (const hook of HOOKS) {
      const result = runHook(hook, JSON.stringify({ hook_event_name: "X", cwd: repo.root }));
      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    }
  });

  it("every hook sets suppressOutput, so passes are silent", () => {
    for (const hook of HOOKS) {
      const result = runHook(hook, JSON.stringify({ hook_event_name: "X", cwd: repo.root }));
      const output = JSON.parse(result.stdout) as { suppressOutput?: boolean };
      expect(output.suppressOutput, `${hook} must suppress output`).toBe(true);
    }
  });

  it("never exits 1 for policy — 1 is non-blocking and would make a gate a no-op", () => {
    // A real violation, which must block with 2 rather than 1.
    repo.write(
      "standards/always-fails/standard.yaml",
      [
        "name: always-fails",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: test-team",
        "severity: high",
        'description: "Always fails."',
      ].join("\n"),
    );
    repo.write(
      "standards/always-fails/rule.ts",
      [
        "import type { Finding, GateContext } from '../../src/standards/types.js';",
        "const rule = (ctx: GateContext): Finding[] =>",
        "  ctx.source.split('\\n').map((_, i) => ({ line: i + 1, message: 'nope', fix: 'do it differently' }));",
        "export default rule;",
      ].join("\n"),
    );
    repo.write("keel.config.yaml", "version: 1\nrepo:\n  name: hooktest\n  languages: [typescript]\n");
    repo.write("src/thing.ts", "export const a = 1;\n");

    const result = runHook(
      "post-tool-use",
      JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: repo.root,
        tool_name: "Write",
        tool_input: { file_path: join(repo.root, "src/thing.ts") },
      }),
      repo.root,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("always-fails");
    expect(result.stderr).toContain("fix:");
    expect(result.stderr).toContain("src/thing.ts:1");
  });
});

describe("missing and broken config", () => {
  it("works in a repo with no keel.config.yaml", () => {
    for (const hook of HOOKS) {
      const result = runHook(
        hook,
        JSON.stringify({ hook_event_name: "X", cwd: repo.root, tool_name: "Write", tool_input: { file_path: join(repo.root, "a.ts") } }),
      );
      expect(result.status, `${hook}: ${result.stderr}`).toBe(0);
    }
  });

  it("works with an invalid keel.config.yaml", () => {
    repo.write("keel.config.yaml", "version: 99\nrepo: not-an-object\ngarbage: [\n");
    for (const hook of HOOKS) {
      const result = runHook(hook, JSON.stringify({ hook_event_name: "X", cwd: repo.root }));
      expect(result.status, `${hook}: ${result.stderr}`).toBe(0);
    }
  });

  it("works outside a git repository", () => {
    for (const hook of HOOKS) {
      const result = runHook(hook, JSON.stringify({ hook_event_name: "X", cwd: "/tmp" }));
      expect(result.status, `${hook}: ${result.stderr}`).toBe(0);
    }
  });

  it("works when cwd does not exist", () => {
    for (const hook of HOOKS) {
      const result = runHook(hook, JSON.stringify({ hook_event_name: "X", cwd: "/nonexistent/path/xyz" }));
      expect(result.status, `${hook}: ${result.stderr}`).toBe(0);
    }
  });
});

describe("a broken pack must not break the session", () => {
  beforeEach(() => {
    // TDD gates off: these cases are about the standards path. Left on, gate 3
    // would block the new exported symbol first and mask what is being tested.
    repo.write(
      "keel.config.yaml",
      [
        "version: 1",
        "repo:",
        "  name: hooktest",
        "  languages: [typescript]",
        "tdd:",
        "  enabled: false",
        "",
      ].join("\n"),
    );
    repo.write("src/thing.ts", "export const a = 1;\n");
  });

  it("a rule that throws lets the edit through", () => {
    repo.write(
      "standards/thrower/standard.yaml",
      [
        "name: thrower",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: t",
        "severity: high",
        'description: "Throws."',
      ].join("\n"),
    );
    repo.write("standards/thrower/rule.ts", "const rule = () => { throw new Error('boom'); };\nexport default rule;\n");

    const result = runHook(
      "post-tool-use",
      JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: repo.root,
        tool_name: "Write",
        tool_input: { file_path: join(repo.root, "src/thing.ts") },
      }),
      repo.root,
    );
    expect(result.status).toBe(0);
  });

  it("a rule that never resolves is bounded by the runner, not left hanging", () => {
    repo.write(
      "standards/spinner/standard.yaml",
      [
        "name: spinner",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: t",
        "severity: high",
        'description: "Spins."',
      ].join("\n"),
    );
    // A rule returning a never-resolving promise: the hook must still exit.
    repo.write(
      "standards/spinner/rule.ts",
      "const rule = () => new Promise(() => undefined);\nexport default rule;\n",
    );

    const started = Date.now();
    const result = spawnSync(process.execPath, [bundle("post-tool-use")], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: repo.root,
        tool_name: "Write",
        tool_input: { file_path: join(repo.root, "src/thing.ts") },
      }),
      encoding: "utf8",
      // Well beyond the runner's own 2 s rule timeout: if this fires, nothing
      // bounded the rule and the hook really was hanging.
      timeout: 15_000,
      cwd: repo.root,
    });
    const elapsed = Date.now() - started;

    // The runner gives up on the rule, reports it, and the edit proceeds.
    expect(result.status).toBe(0);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("a malformed standard.yaml does not stop other packs", () => {
    repo.write("standards/broken/standard.yaml", "name: [unclosed\n");
    const result = runHook(
      "post-tool-use",
      JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: repo.root,
        tool_name: "Write",
        tool_input: { file_path: join(repo.root, "src/thing.ts") },
      }),
      repo.root,
    );
    expect(result.status).toBe(0);
  });
});

describe("message-display never breaks the screen", () => {
  it("returns displayContent for a well-formed message", () => {
    const result = runHook(
      "message-display",
      JSON.stringify({
        hook_event_name: "MessageDisplay",
        cwd: repo.root,
        message: "Refreshed the token flow in src/auth/refresh.ts. I assumed a 15m TTL.",
      }),
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { displayContent?: string };
    };
    expect(output.hookSpecificOutput?.displayContent).toContain("decide");
  });

  it("returns no displayContent for a message it cannot parse", () => {
    const result = runHook(
      "message-display",
      JSON.stringify({ hook_event_name: "MessageDisplay", cwd: repo.root, message: { unexpected: true } }),
    );
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: unknown };
    expect(output.hookSpecificOutput).toBeUndefined();
  });
});

describe("hook registration", () => {
  it("registers every bundle that exists, with exec form and ${CLAUDE_PLUGIN_ROOT}", () => {
    const raw = execFileSync("node", ["-e", `process.stdout.write(require('fs').readFileSync('${join(PLUGIN_ROOT, "hooks", "hooks.json")}','utf8'))`], { encoding: "utf8" });
    const parsed = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; args?: string[]; timeout?: number }> }>>;
    };

    const registered: string[] = [];
    for (const matchers of Object.values(parsed.hooks)) {
      for (const matcher of matchers) {
        for (const handler of matcher.hooks) {
          // Exec form: the script path is an argv entry, never concatenated
          // into a shell string where a space in the path would split it.
          expect(handler.command).toBe("node");
          expect(Array.isArray(handler.args)).toBe(true);
          const path = handler.args?.[0] ?? "";
          expect(path).toContain("${CLAUDE_PLUGIN_ROOT}");
          expect(handler.timeout).toBeGreaterThan(0);
          registered.push(path.split("/").pop()?.replace(".mjs", "") ?? "");
        }
      }
    }

    for (const hook of HOOKS) {
      expect(registered, `${hook} must be registered`).toContain(hook);
    }
  });
});
