import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanGotchas } from "../../src/context/gotchas.js";
import { routeSkills } from "../../src/context/skill-router.js";
import { readSessionState, isSpike, setSpike } from "../../src/context/session-state.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-gotcha-");
});

afterEach(() => {
  repo.dispose();
});

describe("gotcha scanner", () => {
  it("finds files with a history of reverts and hotfixes", () => {
    repo.writeCommitted("src/billing.ts", "export const a = 1;\n");
    repo.write("src/billing.ts", "export const a = 2;\n");
    repo.commit("hotfix: billing rounding");
    repo.write("src/billing.ts", "export const a = 3;\n");
    repo.commit("Revert \"billing rounding\"");
    repo.write("src/billing.ts", "export const a = 4;\n");
    repo.commit("hotfix: billing again");

    const found = scanGotchas(repo.root).filter((c) => c.kind === "hotfix-churn");
    expect(found.map((c) => c.path)).toContain("src/billing.ts");
    expect(found[0]?.proposed).toContain("hotfixes");
  });

  it("ignores a file with a single ordinary fix commit", () => {
    repo.writeCommitted("src/calm.ts", "export const a = 1;\n");
    repo.write("src/calm.ts", "export const a = 2;\n");
    repo.commit("fix: typo");

    const found = scanGotchas(repo.root).filter(
      (c) => c.kind === "hotfix-churn" && c.path === "src/calm.ts",
    );
    expect(found).toEqual([]);
  });

  it.each([
    ["hack", "// this is a hack to work around the upstream bug"],
    ["do-not instruction", "// do not remove this import, it registers the adapter"],
    ["careful", "// careful: the order of these two calls matters"],
    ["load-bearing", "// this whitespace is load-bearing for the parser"],
    ["looks unused", "// looks dead but the scheduler calls it by name"],
  ])("surfaces a %s comment", (_label, comment) => {
    repo.writeCommitted("src/thing.ts", `${comment}\nexport const a = 1;\n`);

    const found = scanGotchas(repo.root).filter((c) => c.kind === "warning-comment");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.path).toBe("src/thing.ts");
    expect(found[0]?.line).toBe(1);
  });

  it("reads python comments too", () => {
    repo.writeCommitted("app/task.py", "# careful: this runs inside the celery worker\nX = 1\n");
    const found = scanGotchas(repo.root).filter((c) => c.kind === "warning-comment");
    expect(found.map((c) => c.path)).toContain("app/task.py");
  });

  it("ignores a short comment that carries no knowledge", () => {
    repo.writeCommitted("src/thing.ts", "// hack\nexport const a = 1;\n");
    const found = scanGotchas(repo.root).filter((c) => c.kind === "warning-comment");
    expect(found).toEqual([]);
  });

  it("finds a module nothing imports but configuration names", () => {
    repo.write("src/index.ts", "import { a } from './used.js';\nexport const b = a;\n");
    repo.write("src/used.ts", "export const a = 1;\n");
    repo.write("src/nightly_report.ts", "export const run = () => 1;\n");
    repo.write("config/jobs.yaml", "jobs:\n  - name: nightly_report\n    schedule: '0 2 * * *'\n");
    repo.commit("add job");

    const found = scanGotchas(repo.root).filter((c) => c.kind === "non-static-entry");
    expect(found.map((c) => c.path)).toContain("src/nightly_report.ts");
    expect(found[0]?.proposed).toContain("Do not delete");
    expect(found[0]?.confidence).toBe("high");
  });

  it("does not flag a module that is statically imported", () => {
    repo.write("src/index.ts", "import { a } from './used.js';\nexport const b = a;\n");
    repo.write("src/used.ts", "export const a = 1;\n");
    repo.write("config/jobs.yaml", "jobs:\n  - name: used\n");
    repo.commit("add");

    const found = scanGotchas(repo.root).filter(
      (c) => c.kind === "non-static-entry" && c.path === "src/used.ts",
    );
    expect(found).toEqual([]);
  });

  it("proposes candidates without writing anything", () => {
    repo.writeCommitted("src/thing.ts", "// careful: ordering matters a great deal here\nexport const a = 1;\n");
    const before = repo.git(["status", "--porcelain"]);
    scanGotchas(repo.root);
    expect(repo.git(["status", "--porcelain"])).toBe(before);
  });

  it("returns an empty list for an empty repo rather than throwing", () => {
    expect(scanGotchas(repo.root)).toEqual([]);
  });

  it("honours the max cap and orders by confidence", () => {
    repo.write("src/index.ts", "export const b = 1;\n");
    for (let i = 0; i < 5; i++) {
      repo.write(`src/job${i}.ts`, "export const run = () => 1;\n");
    }
    repo.write("config/jobs.yaml", Array.from({ length: 5 }, (_, i) => `- name: job${i}`).join("\n"));
    repo.writeCommitted("src/note.ts", "// careful: this is a subtle piece of behaviour\nexport const n = 1;\n");

    const capped = scanGotchas(repo.root, { max: 3 });
    expect(capped.length).toBeLessThanOrEqual(3);
    expect(capped[0]?.confidence).toBe("high");
  });
});

describe("skill router", () => {
  function writeGuidePack(name: string): void {
    repo.write(
      `standards/${name}/standard.yaml`,
      [
        `name: ${name}`,
        "mode: guide",
        'applies_to: ["src/api/**/*.ts"]',
        "languages: [typescript]",
        "owner: api-team",
        "severity: low",
        'description: "How we shape API modules."',
      ].join("\n"),
    );
    repo.write(`standards/${name}/guide.md`, "Prefer thin handlers that delegate to a service.");
  }

  it("surfaces a matching guide as additionalContext", () => {
    writeGuidePack("api-shape");
    const result = routeSkills(repo.root, PLUGIN_ROOT, repo.config(), "src/api/charge.ts", "s1");

    expect(result.packs).toContain("api-shape");
    expect(result.additionalContext).toContain("thin handlers");
    // Suggest, never force.
    expect(result.additionalContext).toContain("guidance, not a gate");
  });

  it("returns nothing for a path no guide matches", () => {
    writeGuidePack("api-shape");
    const result = routeSkills(repo.root, PLUGIN_ROOT, repo.config(), "src/ui/Button.ts", "s1");
    expect(result.additionalContext).toBeNull();
    expect(result.packs).toEqual([]);
  });

  it("deduplicates against guides already loaded this session", () => {
    writeGuidePack("api-shape");
    const config = repo.config();

    const first = routeSkills(repo.root, PLUGIN_ROOT, config, "src/api/charge.ts", "s1");
    expect(first.additionalContext).not.toBeNull();

    const second = routeSkills(repo.root, PLUGIN_ROOT, config, "src/api/refund.ts", "s1");
    expect(second.additionalContext).toBeNull();

    // A different session starts clean.
    const other = routeSkills(repo.root, PLUGIN_ROOT, config, "src/api/refund.ts", "s2");
    expect(other.additionalContext).not.toBeNull();
  });

  it("records loaded guides in session state", () => {
    writeGuidePack("api-shape");
    routeSkills(repo.root, PLUGIN_ROOT, repo.config(), "src/api/charge.ts", "s1");
    expect(readSessionState(repo.root, "s1").loadedGuides).toContain("api-shape");
  });

  it("sanitises a hostile session id rather than escaping the state directory", () => {
    expect(() => setSpike(repo.root, "../../etc/passwd", true)).not.toThrow();
    expect(isSpike(repo.root, "../../etc/passwd")).toBe(true);
  });
});

describe("spike mode", () => {
  it("is off by default and settable per session", () => {
    expect(isSpike(repo.root, "s1")).toBe(false);
    setSpike(repo.root, "s1", true);
    expect(isSpike(repo.root, "s1")).toBe(true);
    expect(isSpike(repo.root, "s2")).toBe(false);
  });
});
