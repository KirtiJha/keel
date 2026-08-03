import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KeelConfigSchema,
  formatIssues,
  loadConfigStrict,
  toJsonSchema,
  validateConfig,
  type ConfigIssue,
} from "../../src/shared/config-schema.js";
import {
  defaultConfig,
  loadConfigOrDefaults,
  readConfigValue,
  type KeelConfig,
} from "../../src/shared/config.js";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "keel-config-"));
}

const MINIMAL = { version: 1, repo: { name: "payments-api", languages: ["typescript"] } };

const SPEC_EXAMPLE = {
  version: 1,
  repo: { name: "payments-api", languages: ["typescript", "python"] },
  tracks: { quick: { effort: "low" }, standard: { effort: "medium" }, full: { effort: "high" } },
  router: {
    force_full_globs: ["**/migrations/**", "**/auth/**", "openapi/**"],
    quick_max_files: 1,
    quick_max_lines: 50,
  },
  standards: { packs_ref: "keel-standards@1.0.0", disabled: [] },
  tdd: { enabled: true, outer_loop: false, exempt_globs: ["**/*.config.ts", "**/migrations/**"] },
  telemetry: { sink: "file", path: ".keel/telemetry" },
};

// ---------------------------------------------------------------------------
// Strict schema — the "fail loud at keel init" half of constraint 0.9
// ---------------------------------------------------------------------------

describe("strict schema", () => {
  it("accepts a minimal config and fills every default", () => {
    const result = validateConfig(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const c = result.value;
    expect(c.tracks.quick.effort).toBe("low");
    expect(c.tracks.standard.effort).toBe("medium");
    expect(c.tracks.full.effort).toBe("high");
    expect(c.router.quick_max_files).toBe(1);
    expect(c.router.quick_max_lines).toBe(50);
    expect(c.router.escalate_caller_threshold).toBe(5);
    expect(c.tdd.enabled).toBe(true);
    expect(c.tdd.outer_loop).toBe(false);
    expect(c.telemetry.sink).toBe("file");
    expect(c.display.budget_ms).toBe(100);
  });

  it("accepts the full example from the build spec", () => {
    const result = validateConfig(SPEC_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.router.force_full_globs).toHaveLength(3);
    expect(result.value.standards.packs_ref).toBe("keel-standards@1.0.0");
  });

  it("ships outer_loop false — integration TDD is deferred", () => {
    expect(defaultConfig("x", ["typescript"]).tdd.outer_loop).toBe(false);
  });

  it("ships the plan's spec cap and mutation floor", () => {
    const c = defaultConfig("x", ["typescript"]);
    expect(c.spec.max_lines).toBe(250);
    expect(c.mutation.min_score).toBe(0.5);
    // EARS is optional and untried; the plan says decide after two changes.
    expect(c.spec.ears).toBe(false);
  });

  it("names the field and the fix for a bad version", () => {
    const result = validateConfig({ ...MINIMAL, version: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.error.find((i: ConfigIssue) => i.path === "version");
    expect(issue?.fix).toContain("version: 1");
  });

  it("names the field and the fix for a missing repo name", () => {
    const result = validateConfig({ version: 1, repo: { languages: ["typescript"] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.find((i: ConfigIssue) => i.path === "repo.name")?.fix).toContain("payments-api");
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    const result = validateConfig({ ...MINIMAL, tracksss: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatIssues(result.error)).toContain("tracksss");
  });

  it("rejects a non-positive quick_max_files with a usable fix", () => {
    const result = validateConfig({ ...MINIMAL, router: { quick_max_files: 0 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.error.find((i: ConfigIssue) => i.path === "router.quick_max_files")?.fix,
    ).toContain("positive integer");
  });

  it("rejects an unknown language", () => {
    expect(validateConfig({ version: 1, repo: { name: "x", languages: ["cobol"] } }).ok).toBe(false);
  });
});

describe("loadConfigStrict", () => {
  it("explains how to create a missing config", () => {
    const result = loadConfigStrict(tempRepo());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.fix).toContain("keel init");
  });

  it("reports a YAML syntax error without throwing", () => {
    const root = tempRepo();
    writeFileSync(join(root, "keel.config.yaml"), "version: 1\n  bad:\n :indent\n", "utf8");
    const result = loadConfigStrict(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.path).toBe("(yaml)");
  });

  it("round-trips a written config", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, "keel.config.yaml"),
      "version: 1\nrepo:\n  name: demo\n  languages: [python]\n",
      "utf8",
    );
    const result = loadConfigStrict(root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.repo.name).toBe("demo");
    expect(result.value.config.repo.languages).toEqual(["python"]);
  });
});

// ---------------------------------------------------------------------------
// Runtime reader — the "fail safe at runtime" half
// ---------------------------------------------------------------------------

describe("runtime reader", () => {
  it("returns usable defaults when no config exists", () => {
    const resolved = loadConfigOrDefaults(tempRepo(), "fallback-repo");
    expect(resolved.present).toBe(false);
    expect(resolved.config.repo.name).toBe("fallback-repo");
    expect(resolved.config.tdd.enabled).toBe(true);
  });

  it("coerces an invalid config instead of throwing", () => {
    const root = tempRepo();
    writeFileSync(join(root, "keel.config.yaml"), "version: 99\nrepo: nonsense\n", "utf8");
    const resolved = loadConfigOrDefaults(root, "fallback-repo");
    expect(resolved.present).toBe(true);
    expect(resolved.config.repo.name).toBe("fallback-repo");
    expect(resolved.config.tdd.enabled).toBe(true);
  });

  it("survives unparseable YAML", () => {
    const root = tempRepo();
    writeFileSync(join(root, "keel.config.yaml"), "version: 1\n  bad:\n :indent\n", "utf8");
    expect(() => loadConfigOrDefaults(root)).not.toThrow();

    // Not throwing is the weaker half. What a caller depends on is getting a
    // usable config back — a reader that returned an empty object would also
    // "survive", and every gate downstream would silently run on nothing.
    const resolved = loadConfigOrDefaults(root);
    expect(resolved.config.router.quick_max_files).toBe(1);
    expect(resolved.config.tdd.enabled).toBe(true);
    expect(resolved.config.standards.dirs).toContain("standards");
  });

  it("keeps the valid parts of a partially broken config", () => {
    const config = readConfigValue(
      { version: 1, repo: { name: "real-name", languages: ["python"] }, router: "not-an-object" },
      "fallback",
    );
    expect(config.repo.name).toBe("real-name");
    expect(config.repo.languages).toEqual(["python"]);
    expect(config.router.quick_max_files).toBe(1);
  });

  it("honours an explicitly empty disabled list", () => {
    expect(readConfigValue({ ...MINIMAL, standards: { disabled: [] } }).standards.disabled).toEqual([]);
  });

  it("clamps display.budget_ms into range", () => {
    expect(readConfigValue({ ...MINIMAL, display: { budget_ms: 99_999 } }).display.budget_ms).toBe(5000);
    expect(readConfigValue({ ...MINIMAL, display: { budget_ms: 1 } }).display.budget_ms).toBe(100);
  });

  it("never throws on hostile input", () => {
    for (const raw of [null, undefined, 42, "string", [], { repo: [] }, { tracks: 7 }]) {
      expect(() => readConfigValue(raw)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The two paths must agree
// ---------------------------------------------------------------------------

describe("cross-check — the fast reader matches the strict schema", () => {
  /**
   * Configs that are *valid*. For these, the coercing reader and the strict
   * schema must produce byte-identical output, or hooks and `keel check` would
   * be enforcing different rules — the exact drift the split risks.
   */
  const VALID_CORPUS: ReadonlyArray<readonly [string, unknown]> = [
    ["minimal", MINIMAL],
    ["spec example", SPEC_EXAMPLE],
    ["python only", { version: 1, repo: { name: "svc", languages: ["python"] } }],
    [
      "all fields set",
      {
        version: 1,
        repo: { name: "full", languages: ["typescript", "python"] },
        tracks: { quick: { effort: "medium" }, standard: { effort: "high" }, full: { effort: "high" } },
        router: {
          force_full_globs: ["a/**"],
          quick_max_files: 3,
          quick_max_lines: 200,
          escalate_caller_threshold: 9,
          package_roots: ["libs/*"],
        },
        standards: { packs_ref: "p@2.0.0", disabled: ["x"], dirs: ["std", "more"] },
        tdd: {
          enabled: false,
          outer_loop: true,
          exempt_globs: ["gen/**"],
          test_globs: ["**/*.spec.ts"],
        },
        telemetry: { sink: "none", path: "tmp/tel" },
        upstream: { enabled_skills: ["a"], disabled_skills: ["b"] },
        display: { enabled: false, budget_ms: 50 },
        spec: { dir: "specs", max_lines: 120, ears: true, require_proposal_on_full: false },
        mutation: {
          enabled: false,
          min_score: 0.75,
          max_mutants: 10,
          timeout_ms: 30_000,
          test_command: "make test",
        },
      },
    ],
    ["spec only", { ...MINIMAL, spec: { max_lines: 100 } }],
    ["mutation only", { ...MINIMAL, mutation: { min_score: 0.8 } }],
    ["empty disabled list", { ...MINIMAL, standards: { disabled: [] } }],
    ["empty force_full_globs", { ...MINIMAL, router: { force_full_globs: [] } }],
  ];

  for (const [name, raw] of VALID_CORPUS) {
    it(`agrees on: ${name}`, () => {
      const strict = validateConfig(raw);
      expect(strict.ok, `corpus entry "${name}" must be valid`).toBe(true);
      if (!strict.ok) return;

      const fast = readConfigValue(raw, "payments-api");

      // Compared as JSON so readonly/mutable differences do not mask a real one.
      expect(JSON.parse(JSON.stringify(fast))).toEqual(JSON.parse(JSON.stringify(strict.value)));
    });
  }

  it("produces the same defaults from both paths", () => {
    const strict = validateConfig(MINIMAL);
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;

    const literal: KeelConfig = defaultConfig("payments-api", ["typescript"]);
    expect(JSON.parse(JSON.stringify(literal))).toEqual(JSON.parse(JSON.stringify(strict.value)));
  });
});

// ---------------------------------------------------------------------------
// Generated JSON Schema
// ---------------------------------------------------------------------------

describe("JSON Schema generation", () => {
  it("describes the real fields", () => {
    const schema = toJsonSchema();
    expect(schema["type"]).toBe("object");
    expect(Object.keys(schema["properties"] as Record<string, unknown>).sort()).toEqual(
      [
        "display",
        "mutation",
        "repo",
        "router",
        "spec",
        "standards",
        "tdd",
        "telemetry",
        "tracks",
        "upstream",
        "version",
      ].sort(),
    );
  });

  it("stays in step with the Zod schema — same top-level keys", () => {
    expect(Object.keys(toJsonSchema()["properties"] as Record<string, unknown>).sort()).toEqual(
      Object.keys(KeelConfigSchema.shape).sort(),
    );
  });
});
