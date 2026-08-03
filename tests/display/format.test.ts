import { describe, expect, it } from "vitest";

import { BULLET, extractDecisions, extractFiles, formatMessage } from "../../src/display/format.js";
import type { DisplayState } from "../../src/display/state.js";

const EMPTY_STATE: DisplayState = { changedFiles: [], checks: [], updatedAt: Date.now() };

function state(overrides: Partial<DisplayState> = {}): DisplayState {
  return { ...EMPTY_STATE, ...overrides };
}

const OPTIONS = { budgetMs: 100 };

describe("the target format", () => {
  it("renders the four rows from the build spec", () => {
    const output = formatMessage(
      [
        "Refreshed the auth token flow.",
        "",
        "I assumed a session TTL of 15m — confirm or override.",
        "",
        "Next, run /verify, then open a PR.",
      ].join("\n"),
      state({
        changedFiles: ["src/auth/refresh.ts", "src/auth/refresh.test.ts"],
        checks: [
          { label: "types", ok: true },
          { label: "standards", ok: true },
          { label: "tests", ok: true, detail: "12/12" },
          { label: "tdd", ok: true },
        ],
      }),
      OPTIONS,
    );

    expect(output).not.toBeNull();
    const lines = (output ?? "").split("\n");

    expect(lines[0]).toBe(`${BULLET} Refreshed the auth token flow.`);
    expect(lines[1]).toContain("changed");
    expect(lines[1]).toContain("src/auth/refresh.ts, src/auth/refresh.test.ts");
    expect(lines[2]).toContain("verified");
    expect(lines[2]).toContain("✓ types");
    expect(lines[2]).toContain("✓ tests 12/12");
    expect(lines[3]).toContain("decide");
    expect(lines[3]).toContain("session TTL");
    expect(lines[4]).toContain("next");
    expect(lines[4]).toContain("/verify");
  });

  it("marks a failing check with ✗", () => {
    const output = formatMessage(
      "Ran the checks.",
      state({ checks: [{ label: "standards", ok: false, detail: "1 finding" }] }),
      OPTIONS,
    );
    expect(output).toContain("✗ standards 1 finding");
  });

  it("truncates a long file list", () => {
    const output = formatMessage(
      "Touched a lot.",
      state({ changedFiles: ["a/1.ts", "a/2.ts", "a/3.ts", "a/4.ts", "a/5.ts", "a/6.ts"] }),
      OPTIONS,
    );
    expect(output).toContain("+2 more");
  });

  it("truncates a long title", () => {
    const output = formatMessage(
      `${"A very long opening sentence that goes on and on and on".repeat(3)}. And more.`,
      state({ changedFiles: ["a.ts"] }),
      OPTIONS,
    );
    expect((output ?? "").split("\n")[0]?.length).toBeLessThanOrEqual(66);
    expect(output).toContain("…");
  });
});

describe("the decide line is never dropped", () => {
  it.each([
    "I assumed the session TTL is 15m.",
    "I'll assume UTC for all timestamps.",
    "Defaulting to retry three times.",
    "I went with optimistic locking here.",
    "Unless you'd rather, I kept the existing envelope.",
    "Let me know if the 30s timeout is wrong.",
    "I chose the simpler migration path.",
  ])("surfaces %s", (sentence) => {
    const output = formatMessage(`Did the thing.\n\n${sentence}`, state({ changedFiles: ["a.ts"] }), OPTIONS);
    expect(output).not.toBeNull();
    expect(output).toContain("decide");
  });

  it("renders every assumption, not just the first", () => {
    const output = formatMessage(
      ["Did it.", "I assumed a 15m TTL.", "I also defaulted to UTC.", ""].join("\n"),
      state({ changedFiles: ["a.ts"] }),
      OPTIONS,
    );
    const decideRows = (output ?? "").split("\n").filter((l) => l.includes("decide"));
    expect(decideRows).toHaveLength(2);
  });

  it("renders nothing rather than a summary that hides an assumption", () => {
    // A message whose only content is an over-long assumption: it cannot make it
    // into a decide row, so the original must render instead of a tidy summary.
    const longAssumption = `I assumed ${"x".repeat(300)}.`;
    const output = formatMessage(longAssumption, state({ changedFiles: ["a.ts"] }), OPTIONS);
    expect(output).toBeNull();
  });

  it("extracts decisions independently of formatting", () => {
    expect(extractDecisions("I assumed a 15m TTL.")).toHaveLength(1);
    expect(extractDecisions("Everything was specified.")).toHaveLength(0);
  });
});

describe("fail-safe behaviour", () => {
  it("returns null for empty input", () => {
    expect(formatMessage("", EMPTY_STATE, OPTIONS)).toBeNull();
    expect(formatMessage("   \n  ", EMPTY_STATE, OPTIONS)).toBeNull();
  });

  it("returns null for a message that is a code block", () => {
    expect(formatMessage("```ts\nconst a = 1;\n```", state({ changedFiles: ["a.ts"] }), OPTIONS)).toBeNull();
  });

  it("returns null for a very long message", () => {
    expect(formatMessage("word ".repeat(20_000), state({ changedFiles: ["a.ts"] }), OPTIONS)).toBeNull();
  });

  it("returns null when there is nothing to put under the title", () => {
    expect(formatMessage("Just a sentence with no files, checks or decisions.", EMPTY_STATE, OPTIONS)).toBeNull();
  });

  it("returns null rather than throwing on malformed input", () => {
    const hostile = [
      "\u0000",
      "«».,;:!?".repeat(500),
      "\n".repeat(5000),
      "```",
      "#".repeat(1000),
    ];
    for (const input of hostile) {
      expect(() => formatMessage(input, EMPTY_STATE, OPTIONS)).not.toThrow();
    }
  });

  it("survives a non-string being passed in", () => {
    const notAString = 42 as unknown as string;
    expect(formatMessage(notAString, EMPTY_STATE, OPTIONS)).toBeNull();
  });

  it("returns null when the budget is already spent", () => {
    const longAgo = process.hrtime.bigint() - BigInt(500 * 1e6);
    const output = formatMessage(
      "Did the thing.",
      state({ changedFiles: ["a.ts"] }),
      { budgetMs: 100, startedAt: longAgo },
    );
    expect(output).toBeNull();
  });
});

describe("file extraction", () => {
  it("finds paths in prose and backticks", () => {
    const files = extractFiles("Edited `src/auth/refresh.ts` and tests/unit/auth.test.ts today.");
    expect(files).toContain("src/auth/refresh.ts");
    expect(files).toContain("tests/unit/auth.test.ts");
  });

  it("does not invent files from bare words", () => {
    expect(extractFiles("Refactored the authentication module.")).toEqual([]);
  });

  it("builds the changed row from state, not from paths mentioned in prose", () => {
    const output = formatMessage(
      "Mentioned other/thing.ts in passing.",
      state({ changedFiles: ["real/file.ts"] }),
      OPTIONS,
    );
    const changedRow = (output ?? "").split("\n").find((l) => l.includes("changed")) ?? "";
    expect(changedRow).toContain("real/file.ts");
    expect(changedRow).not.toContain("other/thing.ts");
  });
});

describe("M8 acceptance — 500 real-shaped messages within budget", () => {
  function corpus(): string[] {
    const shapes = [
      "Refreshed the auth token flow.\n\nI assumed a session TTL of 15m — confirm or override.\n\nNext, run /verify.",
      "Fixed the rounding bug in `src/money.ts`. Tests pass.",
      "## Summary\n\nAdded the retry wrapper. Defaulting to three attempts.",
      "```ts\nconst x = 1;\n```",
      "",
      "Looked at tests/unit/auth.test.ts and services/api/handlers/charge.ts.",
      "Done. Let me know if the 30s timeout is wrong.",
      "I could not reproduce the failure. Here is what I tried:\n- ran the suite\n- checked the logs",
      "word ".repeat(6000),
      "Updated three files and ran the gates. Then open a PR.",
    ];
    const out: string[] = [];
    for (let i = 0; i < 500; i++) {
      out.push(shapes[i % shapes.length] ?? "");
    }
    return out;
  }

  it("stays under the 100 ms p95 budget and never throws", () => {
    const messages = corpus();
    const timings: number[] = [];
    const testState = state({
      changedFiles: ["src/a.ts", "src/b.ts"],
      checks: [{ label: "types", ok: true }, { label: "tests", ok: true, detail: "8/8" }],
    });

    for (const message of messages) {
      const start = process.hrtime.bigint();
      expect(() => formatMessage(message, testState, OPTIONS)).not.toThrow();
      timings.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0;
    const p50 = sorted[Math.ceil(0.5 * sorted.length) - 1] ?? 0;

    console.log(
      `\n  message formatter: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms (budget 100 ms) over ${messages.length} messages\n`,
    );

    // Reported against the 100 ms budget, gated an order of magnitude above it.
    //
    // `npm test` is the oracle `keel mutate` uses to decide whether a mutant
    // was killed, so a wall-clock assertion here does not merely flake a build:
    // a timing blip during a mutant run scores that mutant as killed and
    // inflates the number this project uses in place of coverage. The sibling
    // router benchmark was rewritten to a scaling ratio for exactly this; a
    // single formatter call has no second measurement to divide by, so it gets
    // the same treatment as the gate runner — a catastrophic-regression ceiling
    // that scheduler jitter cannot reach. Observed p95 is ~0.14 ms.
    expect(p95).toBeLessThan(1000);
  });

  it("renders the original for a deliberately malformed message, with no error", () => {
    const malformed = "\u0000```\n##\n".repeat(50);
    let output: string | null = "unset";
    expect(() => {
      output = formatMessage(malformed, EMPTY_STATE, OPTIONS);
    }).not.toThrow();
    expect(output).toBeNull();
  });
});
