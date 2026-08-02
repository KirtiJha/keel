import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPacks, searchRoots } from "../../src/standards/loader.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-loader-");
});

afterEach(() => {
  repo.dispose();
});

const VALID_PACK = [
  "name: sample-rule",
  "mode: gate",
  "applies_to: [\"src/**/*.ts\"]",
  "languages: [typescript]",
  "owner: platform-team",
  "severity: high",
  "description: \"A sample.\"",
].join("\n");

const RULE_SOURCE = "const rule = () => [];\nexport default rule;\n";

describe("search roots", () => {
  it("puts plugin packs first and repo-local packs last, so repo wins", () => {
    const roots = searchRoots(repo.root, PLUGIN_ROOT, repo.config());
    expect(roots[0]).toContain(PLUGIN_ROOT);
    expect(roots[roots.length - 1]).toContain(repo.root);
  });

  it("de-duplicates when the repo is the plugin (this repo during development)", () => {
    const roots = searchRoots(PLUGIN_ROOT, PLUGIN_ROOT, repo.config());
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe("discovery", () => {
  it("loads the two reference packs that ship with the plugin", () => {
    const result = loadPacks(repo.root, PLUGIN_ROOT, repo.config());
    const names = result.packs.map((p) => p.standard.name);
    expect(names).toContain("no-raw-color-values");
    expect(names).toContain("error-envelope");
  });

  it("reports no issues for the packs that ship with the plugin", () => {
    const result = loadPacks(repo.root, PLUGIN_ROOT, repo.config());
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("finds a repo-local pack", () => {
    repo.write("standards/sample-rule/standard.yaml", VALID_PACK);
    repo.write("standards/sample-rule/rule.ts", RULE_SOURCE);

    const result = loadPacks(repo.root, PLUGIN_ROOT, repo.config());
    expect(result.packs.map((p) => p.standard.name)).toContain("sample-rule");
  });

  it("records the rule, guide and rubric files a pack ships", () => {
    repo.write("standards/sample-rule/standard.yaml", VALID_PACK);
    repo.write("standards/sample-rule/rule.ts", RULE_SOURCE);
    repo.write("standards/sample-rule/rubric.md", "- check the thing");

    const pack = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).packs.find(
      (p) => p.standard.name === "sample-rule",
    );
    expect(pack?.ruleTsPath).toContain("rule.ts");
    expect(pack?.rubricPath).toContain("rubric.md");
    expect(pack?.guidePath).toBeNull();
  });
});

describe("validation", () => {
  it("rejects a pack whose name does not match its folder", () => {
    repo.write("standards/wrong-folder/standard.yaml", VALID_PACK);
    repo.write("standards/wrong-folder/rule.ts", RULE_SOURCE);

    const result = loadPacks(repo.root, PLUGIN_ROOT, repo.config());
    const issue = result.issues.find((i) => i.pack.includes("wrong-folder"));
    expect(issue?.message).toContain("does not match folder");
    expect(result.packs.some((p) => p.standard.name === "sample-rule")).toBe(false);
  });

  it("rejects gate mode with no rule file and says what to do", () => {
    repo.write("standards/sample-rule/standard.yaml", VALID_PACK);

    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) =>
      i.message.includes("no rule.ts"),
    );
    expect(issue).toBeDefined();
    expect(issue?.fix).toContain("add a rule file");
  });

  it("rejects guide mode with no guide.md", () => {
    repo.write(
      "standards/guide-pack/standard.yaml",
      VALID_PACK.replace("name: sample-rule", "name: guide-pack").replace("mode: gate", "mode: guide"),
    );

    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) =>
      i.message.includes("no guide.md"),
    );
    expect(issue).toBeDefined();
  });

  it("rejects review mode with no rubric.md", () => {
    repo.write(
      "standards/review-pack/standard.yaml",
      VALID_PACK.replace("name: sample-rule", "name: review-pack").replace("mode: gate", "mode: review"),
    );

    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) =>
      i.message.includes("no rubric.md"),
    );
    expect(issue).toBeDefined();
  });

  it("reports a malformed standard.yaml without throwing", () => {
    repo.write("standards/broken/standard.yaml", "name: [unclosed\n");
    expect(() => loadPacks(repo.root, PLUGIN_ROOT, repo.config())).not.toThrow();
    expect(loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.length).toBeGreaterThan(0);
  });

  it("reports a missing standard.yaml in a pack-shaped directory", () => {
    repo.write("standards/empty-dir/notes.txt", "hello");
    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) =>
      i.message.includes("no standard.yaml"),
    );
    expect(issue).toBeDefined();
  });

  it("rejects an unknown mode with an actionable fix", () => {
    repo.write("standards/sample-rule/standard.yaml", VALID_PACK.replace("mode: gate", "mode: enforce"));
    repo.write("standards/sample-rule/rule.ts", RULE_SOURCE);

    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) => i.path === "mode");
    expect(issue?.fix).toContain("gate");
  });

  it("rejects an empty applies_to — a pack that matches nothing can never fire", () => {
    repo.write("standards/sample-rule/standard.yaml", VALID_PACK.replace('applies_to: ["src/**/*.ts"]', "applies_to: []"));
    repo.write("standards/sample-rule/rule.ts", RULE_SOURCE);

    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) =>
      i.path.startsWith("applies_to"),
    );
    expect(issue).toBeDefined();
  });

  it("requires an owner — an unowned rule is an undeletable rule", () => {
    repo.write("standards/sample-rule/standard.yaml", VALID_PACK.replace("owner: platform-team", "owner: \"\""));
    repo.write("standards/sample-rule/rule.ts", RULE_SOURCE);

    const issue = loadPacks(repo.root, PLUGIN_ROOT, repo.config()).issues.find((i) => i.path === "owner");
    expect(issue).toBeDefined();
  });
});

describe("precedence", () => {
  it("lets a repo-local pack override an org pack of the same name, and records it", () => {
    repo.write(
      "standards/no-raw-color-values/standard.yaml",
      [
        "name: no-raw-color-values",
        "mode: gate",
        'applies_to: ["src/**/*.ts"]',
        "languages: [typescript]",
        "owner: local-team",
        "severity: low",
        'description: "Local override."',
      ].join("\n"),
    );
    repo.write("standards/no-raw-color-values/rule.ts", RULE_SOURCE);

    const result = loadPacks(repo.root, PLUGIN_ROOT, repo.config());
    const pack = result.packs.find((p) => p.standard.name === "no-raw-color-values");

    expect(pack?.standard.owner).toBe("local-team");
    expect(pack?.dir).toContain(repo.root);

    const override = result.overrides.find((o) => o.name === "no-raw-color-values");
    expect(override).toBeDefined();
    expect(override?.winner).toContain(repo.root);
    expect(override?.loser).toContain(PLUGIN_ROOT);
  });
});

describe("disabling", () => {
  it("omits a pack listed in standards.disabled", () => {
    const config = repo.config();
    const result = loadPacks(repo.root, PLUGIN_ROOT, {
      ...config,
      standards: { ...config.standards, disabled: ["error-envelope"] },
    });

    expect(result.packs.map((p) => p.standard.name)).not.toContain("error-envelope");
    expect(result.disabled).toContain("error-envelope");
  });
});
