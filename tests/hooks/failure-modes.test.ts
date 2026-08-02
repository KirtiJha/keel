import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetTrustCache, trustRule } from "../../src/standards/trust.js";

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

function runHook(name: string, input: string | Buffer, cwd?: string): RunResult {
  const result = spawnSync(process.execPath, [bundle(name)], {
    input,
    encoding: "utf8",
    timeout: 20_000,
    cwd: cwd ?? PLUGIN_ROOT,
    env: { ...process.env, KEEL_SESSION_ID: "failure-modes" },
    // A blocking reason can run to megabytes. The 1 MB default would clip it
    // here in the test harness and hide whether the hook itself clipped it.
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Feed a hook its payload in `pieces`, pausing `gapMs` between them, so the
 * writer is slow but never actually stalled. `spawnSync` cannot express this —
 * it hands over the whole payload at once.
 */
async function runHookSlowly(
  name: string,
  payload: string,
  pieces: number,
  gapMs: number,
  cwd?: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolveRun) => {
    const child = spawn(process.execPath, [bundle(name)], {
      cwd: cwd ?? PLUGIN_ROOT,
      env: { ...process.env, KEEL_SESSION_ID: "failure-modes" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    // The hook may stop reading before we stop writing; that is not a failure.
    child.stdin.on("error", () => undefined);

    const size = Math.ceil(payload.length / pieces);
    let sent = 0;
    const tick = (): void => {
      if (sent >= payload.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(payload.slice(sent, sent + size));
      sent += size;
      setTimeout(tick, gapMs);
    };
    tick();

    child.on("close", (code) => {
      resolveRun({ status: code ?? -1, stdout, stderr });
    });
  });
}

let repo: TempRepo;
let keelHome: string;

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
  // Approvals are signed with a machine-local key. Point that at a temp
  // directory so a test can never read — or write — the developer's real one.
  // The hooks run as subprocesses and inherit this through `process.env`.
  keelHome = mkdtempSync(join(tmpdir(), "keel-hook-home-"));
  process.env["KEEL_HOME"] = keelHome;
  resetTrustCache();
});

afterEach(() => {
  repo.dispose();
  rmSync(keelHome, { recursive: true, force: true });
  delete process.env["KEEL_HOME"];
});

/**
 * Approve a repo-local pack's rule, the way a human runs `keel trust add`.
 *
 * A rule that ships in the repository is code the repository chose to run, so
 * it does not execute until someone approves it. Fixtures here write their own
 * packs, which makes them untrusted by construction — without this the gate
 * would quietly decline to run and these tests would assert nothing while
 * appearing to pass.
 */
function trust(name: string): void {
  const result = trustRule(
    { repoRoot: repo.root, pluginRoot: PLUGIN_ROOT, config: repo.config() },
    name,
  );
  if (!result.ok) throw new Error(`could not trust ${name}: ${result.error}`);
}

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
    // `tdd.enabled: false` so the assertion is about the *standards* gate.
    // Otherwise gate 3 blocks first — src/thing.ts declares a new export with
    // no paired test — and the standards finding never reaches stderr.
    repo.write(
      "keel.config.yaml",
      "version: 1\nrepo:\n  name: hooktest\n  languages: [typescript]\ntdd:\n  enabled: false\n",
    );
    repo.write("src/thing.ts", "export const a = 1;\n");
    trust("always-fails");

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

describe("stdin a hook cannot use", () => {
  /**
   * Past V8's maximum string length (~512 MB), so turning the accumulated
   * buffer into a string throws ERR_STRING_TOO_LONG. That throw happened inside
   * a stdin listener, which makes it an *uncaughtException* rather than a
   * promise rejection: runHook's fail-open catch never saw it, and Node exited
   * 1 with a stack trace on stderr. Exit 1 is Claude Code's "non-blocking
   * error", so the gate became a silent no-op that also shouted at the user.
   */
  const OVERSIZE_BYTES = 600_000_000;

  for (const hook of HOOKS) {
    it(`${hook} exits 0 with valid JSON on stdin too large to decode`, () => {
      const result = runHook(hook, Buffer.alloc(OVERSIZE_BYTES));

      expect(result.status, `stderr: ${result.stderr.slice(0, 400)}`).toBe(0);
      expect(result.stderr).not.toContain("ERR_STRING_TOO_LONG");
      // A stack trace on stderr is itself the bug, whatever the exit code says.
      expect(result.stderr).not.toContain("at Socket.");
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
      const output = JSON.parse(result.stdout) as { suppressOutput?: boolean };
      expect(output.suppressOutput).toBe(true);
    });
  }

  it("reads a slow but steadily progressing writer to the end", async () => {
    const payload = JSON.stringify({
      hook_event_name: "MessageDisplay",
      cwd: repo.root,
      message: "Refreshed the token flow in src/auth/refresh.ts. I assumed a 15m TTL.",
    });

    // Six pieces 800 ms apart: ~4.8 s in total, well past the old 3 s budget,
    // but every individual gap is inside the idle deadline. The deadline is
    // idle-based now, so a writer that keeps making progress is never cut off.
    const result = await runHookSlowly("message-display", payload, 6, 800);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { displayContent?: string };
    };
    // Proof the whole payload arrived: a truncated read parses to `{}`, which
    // yields no message and therefore no displayContent at all.
    expect(output.hookSpecificOutput?.displayContent).toContain("decide");
  });
});

describe("a blocking reason reaches Claude whole", () => {
  // keel: allow-test-change renamed from "does not truncate a large reason on
  // the way out" and dropped its size assertion. The old name and the
  // `> 500_000` check both encoded the belief that a big reason should arrive
  // in full; the formatter now caps at 20 findings on purpose, so asserting
  // size would pin the wrong behaviour. The property is unchanged and still
  // asserted below — the end of the output must survive the pipe.
  it("caps a large reason explicitly rather than losing the end of it", () => {
    // Two separate things could shorten this output, and only one of them is
    // acceptable.
    //
    // The bug: stdout/stderr are async when they are pipes — exactly how Claude
    // Code runs a hook — and `process.exit` throws away whatever is still
    // queued, so a long reason arrived cut off mid-word at ~146 KB with no
    // indication anything was missing.
    //
    // The deliberate behaviour: the formatter caps at MAX_RENDERED_FINDINGS and
    // says how many it withheld. 2,000 findings is ~35k tokens of context from
    // one edit, which is not a useful signal at any length.
    //
    // So the property under test is not "the output is huge" — it is that the
    // *end* of what the formatter produced arrives intact. The trailer is
    // written last, so its presence proves the pipe dropped nothing.
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
        "  ctx.source.split('\\n').map((_, i) => ({",
        "    line: i + 1,",
        "    message: 'a very long finding message that repeats '.repeat(4) + i,",
        "    fix: 'a very long remediation hint that repeats '.repeat(4),",
        "  }));",
        "export default rule;",
      ].join("\n"),
    );
    repo.write(
      "keel.config.yaml",
      "version: 1\nrepo:\n  name: hooktest\n  languages: [typescript]\ntdd:\n  enabled: false\n",
    );
    // One finding per line, so the reason runs to hundreds of KB — far past the
    // ~64-146 KB a pipe holds before `process.exit` starts discarding.
    const lines = 2000;
    repo.write(
      "src/thing.ts",
      `${Array.from({ length: lines }, (_, i) => `export const a${i} = ${i};`).join("\n")}\n`,
    );
    trust("always-fails");

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
    // The trailer is the very last thing written, so it is only present if
    // nothing was dropped between the formatter and the pipe.
    expect(result.stderr.trimEnd()).toMatch(/Gates evaluate only the lines this change touched\.$/);
    // Withholding is stated, never silent — the developer can tell the
    // difference between "20 problems" and "20 shown of 2,000".
    expect(result.stderr).toMatch(/…and \d+ more findings not shown\./);
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
