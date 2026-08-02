import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkArchive,
  checkDelta,
  checkProposalRequired,
  checkSize,
  checkSpecs,
} from "../../src/spec/check.js";
import { DELTA_BEGIN, deltaFor, mergeIntoBody, parseDelta, renderDelta } from "../../src/spec/delta.js";
import {
  activeProposals,
  changesDir,
  discoverProposals,
  proposalForBranch,
  specRoot,
} from "../../src/spec/discover.js";
import { earsPattern, isEars } from "../../src/spec/ears.js";
import { isValidChangeId, scaffoldChange } from "../../src/spec/scaffold.js";

import { TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-spec-");
});

afterEach(() => {
  repo.dispose();
});

function proposal(id: string, body: string, archived = false): void {
  const base = archived ? `openspec/changes/archive/${id}` : `openspec/changes/${id}`;
  repo.write(`${base}/proposal.md`, body);
}

const DRAFT = ["---", "status: draft", "---", "", "# thing", "", "## Why", "", "Because."].join("\n");
const APPLIED = ["---", "status: applied", "---", "", "# thing", "", "## Why", "", "Because."].join("\n");

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discovery", () => {
  it("finds active and archived changes", () => {
    proposal("add-webhooks", DRAFT);
    proposal("old-thing", APPLIED, true);

    const all = discoverProposals(repo.root, repo.config());
    expect(all.map((p) => p.id).sort()).toEqual(["add-webhooks", "old-thing"]);
    expect(all.find((p) => p.id === "old-thing")?.archived).toBe(true);
    expect(activeProposals(repo.root, repo.config()).map((p) => p.id)).toEqual(["add-webhooks"]);
  });

  it("reads status from frontmatter", () => {
    proposal("a", DRAFT);
    proposal("b", APPLIED);
    const byId = new Map(discoverProposals(repo.root, repo.config()).map((p) => [p.id, p]));
    expect(byId.get("a")?.status).toBe("draft");
    expect(byId.get("b")?.status).toBe("applied");
  });

  it("treats a fully checked task list as applied", () => {
    proposal("a", "# thing\n\n- [x] do it\n- [x] and this\n");
    expect(discoverProposals(repo.root, repo.config())[0]?.status).toBe("applied");
  });

  it("does not treat a partly checked task list as applied", () => {
    proposal("a", "# thing\n\n- [x] done\n- [ ] not done\n");
    expect(discoverProposals(repo.root, repo.config())[0]?.status).toBe("unknown");
  });

  it("counts lines across every markdown file in the change", () => {
    proposal("a", "one\ntwo\nthree");
    repo.write("openspec/changes/a/specs/api/spec.md", "four\nfive");
    expect(discoverProposals(repo.root, repo.config())[0]?.lineCount).toBe(5);
  });

  it("returns nothing when there is no spec directory", () => {
    expect(discoverProposals(repo.root, repo.config())).toEqual([]);
  });

  it("matches a proposal to a branch by name", () => {
    proposal("add-webhooks", DRAFT);
    proposal("other-change", DRAFT);
    expect(proposalForBranch(repo.root, repo.config(), "feat/add-webhooks")?.id).toBe("add-webhooks");
  });

  it("falls back to the only active proposal when the branch does not name one", () => {
    proposal("add-webhooks", DRAFT);
    expect(proposalForBranch(repo.root, repo.config(), "wip")?.id).toBe("add-webhooks");
  });

  it("refuses to guess between two proposals", () => {
    proposal("a-change", DRAFT);
    proposal("b-change", DRAFT);
    expect(proposalForBranch(repo.root, repo.config(), "wip")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — size cap
// ---------------------------------------------------------------------------

describe("spec size cap", () => {
  it("passes a spec under the cap", () => {
    proposal("a", "line\n".repeat(100));
    expect(checkSize(repo.config(), discoverProposals(repo.root, repo.config()))).toEqual([]);
  });

  it("warns just over the cap rather than failing the build", () => {
    proposal("a", "line\n".repeat(300));
    const issues = checkSize(repo.config(), discoverProposals(repo.root, repo.config()));
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toContain("300 lines");
  });

  it("errors far over the cap", () => {
    proposal("a", "line\n".repeat(500));
    expect(checkSize(repo.config(), discoverProposals(repo.root, repo.config()))[0]?.severity).toBe(
      "error",
    );
  });

  it("ignores archived changes", () => {
    proposal("old", "line\n".repeat(900), true);
    expect(checkSize(repo.config(), discoverProposals(repo.root, repo.config()))).toEqual([]);
  });

  it("honours a configured cap", () => {
    proposal("a", "line\n".repeat(60));
    const config = repo.config();
    const issues = checkSize(
      { ...config, spec: { ...config.spec, max_lines: 50 } },
      discoverProposals(repo.root, repo.config()),
    );
    expect(issues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — archive at merge
// ---------------------------------------------------------------------------

describe("archive at merge", () => {
  it("fails an applied but unarchived change on the default branch", () => {
    proposal("a", APPLIED);
    const issues = checkArchive(discoverProposals(repo.root, repo.config()), true);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.fix).toContain("archive");
  });

  it("says nothing on a feature branch", () => {
    proposal("a", APPLIED);
    expect(checkArchive(discoverProposals(repo.root, repo.config()), false)).toEqual([]);
  });

  it("passes a draft on the default branch — only applied changes must archive", () => {
    proposal("a", DRAFT);
    expect(checkArchive(discoverProposals(repo.root, repo.config()), true)).toEqual([]);
  });

  it("passes once the change is archived", () => {
    proposal("a", APPLIED, true);
    expect(checkArchive(discoverProposals(repo.root, repo.config()), true)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — delta
// ---------------------------------------------------------------------------

describe("delta", () => {
  const WITH_DELTA = [
    "# add webhooks",
    "",
    "## ADDED Requirements",
    "",
    "- The system emits a webhook on payment capture.",
    "",
    "## MODIFIED Requirements",
    "",
    "- Retry policy is now three attempts.",
  ].join("\n");

  it("parses ADDED and MODIFIED sections with their bodies", () => {
    const sections = parseDelta(WITH_DELTA, "proposal.md");
    expect(sections.map((s) => s.kind)).toEqual(["ADDED", "MODIFIED"]);
    expect(sections[0]?.body).toContain("webhook on payment capture");
    expect(sections[1]?.body).toContain("three attempts");
  });

  it("ends a section at the next same-level heading", () => {
    const sections = parseDelta("## ADDED Requirements\n\nbody\n\n## Notes\n\nnot part of it", "p.md");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).not.toContain("not part of it");
  });

  it("finds no sections in a proposal without markers", () => {
    expect(parseDelta("# thing\n\nJust prose.", "p.md")).toEqual([]);
  });

  it("renders a delta with a summary line and the source file", () => {
    proposal("add-webhooks", WITH_DELTA);
    const found = discoverProposals(repo.root, repo.config())[0];
    if (found === undefined) throw new Error("no proposal");

    const rendered = renderDelta(found, deltaFor(repo.root, found));
    expect(rendered).toContain("Spec delta");
    expect(rendered).toContain("add-webhooks");
    expect(rendered).toContain("1 added");
    expect(rendered).toContain("1 modified");
    expect(rendered).toContain("openspec/changes/add-webhooks/proposal.md");
  });

  it("says so plainly when there are no markers", () => {
    proposal("a", "# thing\n\nprose only");
    const found = discoverProposals(repo.root, repo.config())[0];
    if (found === undefined) throw new Error("no proposal");
    expect(renderDelta(found, deltaFor(repo.root, found))).toContain("No delta markers found");
  });

  it("warns when a change has no delta", () => {
    proposal("a", "# thing\n\nprose only");
    const issues = checkDelta(repo.root, discoverProposals(repo.root, repo.config()));
    expect(issues[0]?.severity).toBe("warning");
  });

  it("does not warn when a delta is present", () => {
    proposal("a", WITH_DELTA);
    expect(checkDelta(repo.root, discoverProposals(repo.root, repo.config()))).toEqual([]);
  });
});

describe("PR body merging", () => {
  it("appends to a body that has no delta yet, keeping the original", () => {
    const merged = mergeIntoBody("Fixes #42.", "RENDERED");
    expect(merged).toContain("Fixes #42.");
    expect(merged).toContain("RENDERED");
  });

  it("replaces a previous delta rather than stacking them", () => {
    const first = mergeIntoBody("Body.", `${DELTA_BEGIN}\nold\n<!-- keel:delta:end -->`);
    const second = mergeIntoBody(first, `${DELTA_BEGIN}\nnew\n<!-- keel:delta:end -->`);

    expect(second).toContain("Body.");
    expect(second).toContain("new");
    expect(second).not.toContain("old");
    expect(second.split(DELTA_BEGIN)).toHaveLength(2);
  });

  it("handles an empty body", () => {
    expect(mergeIntoBody("", "RENDERED").trim()).toBe("RENDERED");
  });
});

// ---------------------------------------------------------------------------
// Full-track proposal requirement
// ---------------------------------------------------------------------------

describe("full-track proposal requirement", () => {
  it("fails a full-track change with no proposal", () => {
    const issues = checkProposalRequired(repo.config(), "full", []);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fix).toContain("keel spec new");
  });

  it("passes when a proposal exists", () => {
    proposal("a", DRAFT);
    const issues = checkProposalRequired(
      repo.config(),
      "full",
      discoverProposals(repo.root, repo.config()),
    );
    expect(issues).toEqual([]);
  });

  it("says nothing on quick and standard", () => {
    expect(checkProposalRequired(repo.config(), "quick", [])).toEqual([]);
    expect(checkProposalRequired(repo.config(), "standard", [])).toEqual([]);
  });

  it("can be switched off", () => {
    const config = repo.config();
    const issues = checkProposalRequired(
      { ...config, spec: { ...config.spec, require_proposal_on_full: false } },
      "full",
      [],
    );
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EARS
// ---------------------------------------------------------------------------

describe("EARS", () => {
  it.each([
    ["event", "WHEN a payment is captured THE SYSTEM SHALL emit a webhook"],
    ["unwanted", "IF the webhook fails THEN THE SYSTEM SHALL retry three times"],
    ["state", "WHILE the queue is draining THE SYSTEM SHALL reject new work"],
    ["optional", "WHERE retries are enabled THE SYSTEM SHALL back off exponentially"],
    ["ubiquitous", "THE SYSTEM SHALL record every attempt"],
  ])("recognises the %s pattern", (name, text) => {
    expect(isEars(text)).toBe(true);
    expect(earsPattern(text)).toBe(name);
  });

  it("recognises the pattern through a bullet", () => {
    expect(isEars("- WHEN x happens THE SYSTEM SHALL do y")).toBe(true);
  });

  it("rejects ordinary prose", () => {
    expect(isEars("The system should probably emit a webhook.")).toBe(false);
    expect(isEars("")).toBe(false);
  });

  it("is off by default, so criteria are not checked", () => {
    proposal(
      "a",
      "# thing\n\n## Acceptance criteria\n\n- it works nicely\n",
    );
    const result = checkSpecs({ root: repo.root, config: repo.config() });
    expect(result.issues.filter((i) => i.rule === "ears")).toEqual([]);
  });

  it("warns, never errors, when switched on", () => {
    proposal(
      "a",
      "# thing\n\n## Acceptance criteria\n\n- it works nicely\n- WHEN x THE SYSTEM SHALL y\n",
    );
    const config = repo.config();
    const result = checkSpecs({
      root: repo.root,
      config: { ...config, spec: { ...config.spec, ears: true } },
    });

    const ears = result.issues.filter((i) => i.rule === "ears");
    expect(ears).toHaveLength(1);
    expect(ears[0]?.severity).toBe("warning");
    expect(ears[0]?.message).toContain("it works nicely");
  });
});

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

describe("scaffolding", () => {
  it("validates change ids", () => {
    expect(isValidChangeId("add-webhooks")).toBe(true);
    expect(isValidChangeId("Add_Webhooks")).toBe(false);
    expect(isValidChangeId("a")).toBe(false);
    expect(isValidChangeId("")).toBe(false);
  });

  it("creates structure with delta markers and no invented content", () => {
    const result = scaffoldChange(repo.root, repo.config(), "add-webhooks");
    expect(result.ok).toBe(true);

    const found = discoverProposals(repo.root, repo.config());
    expect(found[0]?.id).toBe("add-webhooks");
    expect(found[0]?.status).toBe("draft");

    if (!result.ok) return;
    expect(existsSync(join(result.value.dir, "proposal.md"))).toBe(true);
    expect(existsSync(join(result.value.dir, "specs"))).toBe(true);

    // Structure, not placeholder prose: the markers exist and carry no content.
    const scaffolded = found[0];
    if (scaffolded === undefined) throw new Error("no proposal");
    const sections = deltaFor(repo.root, scaffolded);
    expect(sections.map((s) => s.kind)).toEqual(["ADDED", "MODIFIED", "REMOVED"]);
    for (const section of sections) expect(section.body).toBe("");
  });

  it("refuses an invalid id with a usable message", () => {
    const result = scaffoldChange(repo.root, repo.config(), "Not Valid");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("kebab-case");
  });

  it("refuses to overwrite an existing change", () => {
    scaffoldChange(repo.root, repo.config(), "add-webhooks");
    expect(scaffoldChange(repo.root, repo.config(), "add-webhooks").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

describe("spec.dir containment", () => {
  let outside: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "keel-spec-outside-"));
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  function specConfig(dir: string) {
    const config = repo.config();
    return { ...config, spec: { ...config.spec, dir } };
  }

  function outsideProposal(): void {
    mkdirSync(join(outside, "changes", "outsider"), { recursive: true });
    writeFileSync(join(outside, "changes", "outsider", "proposal.md"), DRAFT, "utf8");
  }

  it("ignores an absolute spec.dir outside the repo", () => {
    proposal("inside", DRAFT);
    outsideProposal();
    const found = discoverProposals(repo.root, specConfig(outside));
    expect(found.map((p) => p.id)).toEqual(["inside"]);
  });

  it("ignores a `../` walk out of the repo", () => {
    proposal("inside", DRAFT);
    outsideProposal();
    const found = discoverProposals(repo.root, specConfig(relative(repo.root, outside)));
    expect(found.map((p) => p.id)).toEqual(["inside"]);
  });

  it("resolves the spec root inside the repo whatever is configured", () => {
    expect(specRoot(repo.root, specConfig("../../../../tmp/evil"))).toBe(
      join(repo.root, "openspec"),
    );
    expect(changesDir(repo.root, specConfig(outside))).toBe(join(repo.root, "openspec", "changes"));
  });

  it("scaffolds into the repo rather than the escaping directory", () => {
    const result = scaffoldChange(repo.root, specConfig(relative(repo.root, outside)), "evil");
    expect(result.ok).toBe(true);
    expect(existsSync(join(outside, "changes", "evil"))).toBe(false);
    expect(existsSync(join(repo.root, "openspec", "changes", "evil", "proposal.md"))).toBe(true);
  });
});

describe("symlinks in the spec tree", () => {
  let outside: string;

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "keel-spec-link-"));
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not amplify the line count through a symlink loop", () => {
    // Bounded only by ELOOP at ~40 levels, a self-referential directory turned
    // a 4-line proposal into 164 lines — enough to trip or dodge the size cap.
    proposal("loopy", "a\nb\nc\nd");
    const dir = join(repo.root, "openspec", "changes", "loopy");
    symlinkSync(dir, join(dir, "self"), "dir");

    const found = discoverProposals(repo.root, repo.config());
    const loopy = found.find((p) => p.id === "loopy");
    expect(loopy?.files).toHaveLength(1);
    expect(loopy?.lineCount).toBe(4);
  });

  it("terminates on a two-directory symlink cycle", () => {
    proposal("cyclic", "a\nb");
    const dir = join(repo.root, "openspec", "changes", "cyclic");
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    symlinkSync(join(dir, "b"), join(dir, "a", "to-b"), "dir");
    symlinkSync(join(dir, "a"), join(dir, "b", "to-a"), "dir");

    const found = discoverProposals(repo.root, repo.config());
    expect(found.find((p) => p.id === "cyclic")?.lineCount).toBe(2);
  });

  it("does not follow a directory symlink out of the spec tree", () => {
    proposal("x", "# x");
    mkdirSync(join(outside, "secrets"), { recursive: true });
    writeFileSync(join(outside, "secrets", "leak.md"), "1\n2\n3\n4\n5", "utf8");
    symlinkSync(join(outside, "secrets"), join(repo.root, "openspec/changes/x/linked"), "dir");

    const found = discoverProposals(repo.root, repo.config());
    expect(found[0]?.files.some((f) => f.includes("leak.md"))).toBe(false);
  });

  it("does not read a file symlinked out of the spec tree", () => {
    proposal("y", "# y");
    writeFileSync(join(outside, "leak.md"), "1\n2\n3\n4\n5", "utf8");
    symlinkSync(join(outside, "leak.md"), join(repo.root, "openspec/changes/y/leak.md"));

    const found = discoverProposals(repo.root, repo.config());
    expect(found[0]?.files.some((f) => f.includes("leak.md"))).toBe(false);
  });

  it("still walks ordinary nested directories", () => {
    repo.write("openspec/changes/deep/proposal.md", "a");
    repo.write("openspec/changes/deep/specs/cap/spec.md", "b\nc");

    const found = discoverProposals(repo.root, repo.config());
    expect(found[0]?.files).toHaveLength(2);
    expect(found[0]?.lineCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

describe("checkSpecs", () => {
  it("reports nothing for a clean, small, delta-carrying change", () => {
    proposal("a", "# a\n\n## ADDED Requirements\n\n- THE SYSTEM SHALL work\n");
    const result = checkSpecs({ root: repo.root, config: repo.config() });
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it("counts errors and warnings separately", () => {
    proposal("big", "line\n".repeat(500));
    const result = checkSpecs({ root: repo.root, config: repo.config(), onDefaultBranch: true });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.warnings).toBeGreaterThan(0);
  });
});
