import { describe, expect, it } from "vitest";

import { defaultConfig, type KeelConfig } from "../../src/shared/config.js";
import { applyOverride, classify } from "../../src/router/classify.js";
import type { ChangeSignals, ChangedSymbol } from "../../src/router/types.js";

function config(overrides: Partial<KeelConfig["router"]> = {}): KeelConfig {
  const base = defaultConfig("test-repo", ["typescript", "python"]);
  return {
    ...base,
    router: {
      ...base.router,
      force_full_globs: ["**/migrations/**", "**/auth/**", "openapi/**"],
      ...overrides,
    },
  };
}

function signals(overrides: Partial<ChangeSignals> = {}): ChangeSignals {
  return {
    changedFiles: ["src/util.ts"],
    addedLines: 5,
    removedLines: 2,
    changedExportedSymbols: [],
    externalCallerCount: 0,
    ...overrides,
  };
}

function symbol(overrides: Partial<ChangedSymbol> = {}): ChangedSymbol {
  return {
    name: "doThing",
    file: "src/util.ts",
    change: "signature-changed",
    externalCallers: 0,
    crossesPackageBoundary: false,
    ...overrides,
  };
}

describe("rule 1 — force_full_globs", () => {
  it.each([
    ["db/migrations/0001_init.sql", "**/migrations/**"],
    ["src/auth/refresh.ts", "**/auth/**"],
    ["openapi/payments.yaml", "openapi/**"],
  ])("routes %s to full", (path) => {
    const result = classify(signals({ changedFiles: [path] }), config());
    expect(result.track).toBe("full");
    expect(result.reasons.join(" ")).toContain("force-full path");
  });

  it("beats every other rule — a one-line migration is still full", () => {
    const result = classify(
      signals({ changedFiles: ["db/migrations/x.sql"], addedLines: 1, removedLines: 0 }),
      config(),
    );
    expect(result.track).toBe("full");
    expect(result.escalatedFrom).toBe("quick");
  });

  it("does not fire when no path matches", () => {
    expect(classify(signals({ changedFiles: ["src/authenticate.ts"] }), config()).track).toBe("quick");
  });

  it("names the matching glob so the decision is explainable", () => {
    const result = classify(signals({ changedFiles: ["src/auth/token.ts"] }), config());
    expect(result.reasons[0]).toContain("**/auth/**");
  });
});

describe("rule 2 — widely-called exported symbols", () => {
  it("escalates to standard above the caller threshold", () => {
    const result = classify(
      signals({ changedExportedSymbols: [symbol({ externalCallers: 6 })], externalCallerCount: 6 }),
      config({ escalate_caller_threshold: 5 }),
    );
    expect(result.track).toBe("standard");
    expect(result.reasons.join(" ")).toContain("6 external callers");
  });

  it("does not escalate at exactly the threshold", () => {
    const result = classify(
      signals({
        changedFiles: ["src/a.ts", "src/b.ts"],
        changedExportedSymbols: [symbol({ externalCallers: 5 })],
      }),
      config({ escalate_caller_threshold: 5 }),
    );
    // Still standard, but from the file count — not from rule 2.
    expect(result.reasons.join(" ")).not.toContain("external callers");
  });

  it("escalates to full when a hot symbol crosses a package boundary", () => {
    const result = classify(
      signals({
        changedExportedSymbols: [symbol({ externalCallers: 9, crossesPackageBoundary: true })],
      }),
      config(),
    );
    expect(result.track).toBe("full");
    expect(result.reasons.join(" ")).toContain("package boundary");
  });

  it("ignores a boundary crossing when the caller count is below threshold", () => {
    const result = classify(
      signals({
        changedExportedSymbols: [symbol({ externalCallers: 2, crossesPackageBoundary: true })],
      }),
      config(),
    );
    expect(result.track).toBe("standard");
    expect(result.reasons.join(" ")).not.toContain("package boundary");
  });
});

describe("rule 3 — quick", () => {
  it("routes a small single-file change with no signature change to quick", () => {
    expect(classify(signals({ addedLines: 10, removedLines: 5 }), config()).track).toBe("quick");
  });

  it("routes an empty change to quick", () => {
    expect(classify(signals({ changedFiles: [], addedLines: 0, removedLines: 0 }), config()).track).toBe(
      "quick",
    );
  });

  it("counts added plus removed against quick_max_lines", () => {
    const c = config();
    expect(classify(signals({ addedLines: 25, removedLines: 25 }), c).track).toBe("quick");
    expect(classify(signals({ addedLines: 26, removedLines: 25 }), c).track).toBe("standard");
  });

  it("drops out of quick on a second file", () => {
    expect(classify(signals({ changedFiles: ["a.ts", "b.ts"] }), config()).track).toBe("standard");
  });

  it("drops out of quick on any exported signature change, however small", () => {
    const result = classify(
      signals({ addedLines: 1, removedLines: 0, changedExportedSymbols: [symbol()] }),
      config(),
    );
    expect(result.track).toBe("standard");
    expect(result.reasons.join(" ")).toContain("exported signature changed");
  });

  it("honours a raised quick_max_files", () => {
    const result = classify(
      signals({ changedFiles: ["a.ts", "b.ts", "c.ts"] }),
      config({ quick_max_files: 3 }),
    );
    expect(result.track).toBe("quick");
  });
});

describe("escalate-only", () => {
  it("records escalatedFrom when a floor rule raises the track", () => {
    const result = classify(signals({ changedFiles: ["src/auth/a.ts"] }), config());
    expect(result.escalatedFrom).toBe("quick");
  });

  it("omits escalatedFrom when no rule raised anything", () => {
    expect(classify(signals(), config()).escalatedFrom).toBeUndefined();
  });

  it("never lowers a track on its own", () => {
    // Large change plus a forced path: the natural track is standard, the floor
    // is full, and the result must be full.
    const result = classify(
      signals({ changedFiles: ["src/auth/a.ts", "src/b.ts"], addedLines: 400, removedLines: 0 }),
      config(),
    );
    expect(result.track).toBe("full");
  });
});

describe("applyOverride", () => {
  it("lets a developer lower the track and says so", () => {
    const routed = classify(signals({ changedFiles: ["src/auth/a.ts"] }), config());
    const overridden = applyOverride(routed, "quick");
    expect(overridden.track).toBe("quick");
    expect(overridden.reasons[0]).toContain("lowered");
    expect(overridden.escalatedFrom).toBe("full");
  });

  it("lets a developer raise the track", () => {
    const routed = classify(signals(), config());
    const overridden = applyOverride(routed, "full");
    expect(overridden.track).toBe("full");
    expect(overridden.reasons[0]).toContain("raised");
  });

  it("is a no-op when the request matches the routed track", () => {
    const routed = classify(signals(), config());
    expect(applyOverride(routed, "quick")).toBe(routed);
  });
});

describe("determinism", () => {
  it("returns identical results for identical input", () => {
    const s = signals({
      changedFiles: ["src/a.ts", "src/auth/b.ts"],
      changedExportedSymbols: [symbol({ externalCallers: 7 })],
    });
    const c = config();
    const runs = Array.from({ length: 20 }, () => JSON.stringify(classify(s, c)));
    expect(new Set(runs).size).toBe(1);
  });
});
