import { describe, expect, it } from "vitest";

import {
  countRequirements,
  requirementsIn,
  summariseRequirements,
  withRequirementCounts,
} from "../../src/cli/spec-counts.js";
import { parseDelta, renderDelta } from "../../src/spec/delta.js";
import type { Proposal } from "../../src/spec/discover.js";

const proposal = {
  id: "add-webhook-retries",
  status: "draft",
  lineCount: 12,
  archived: false,
  files: [],
  relDir: "openspec/changes/add-webhook-retries",
} as unknown as Proposal;

const section = (body: string) => ({
  kind: "ADDED" as const,
  heading: "Requirements",
  body,
  file: "proposal.md",
});

describe("counting requirements rather than sections", () => {
  it("counts an empty section as zero", () => {
    expect(requirementsIn(section(""))).toBe(0);
  });

  it("counts OpenSpec `### Requirement:` headings", () => {
    expect(
      requirementsIn(
        section(
          [
            "### Requirement: Retry on 5xx",
            "The system SHALL retry.",
            "",
            "### Requirement: Give up after five",
            "The system SHALL stop.",
          ].join("\n"),
        ),
      ),
    ).toBe(2);
  });

  it("falls back to deeper headings when none is named a requirement", () => {
    expect(requirementsIn(section(["### Retries", "text", "### Backoff", "text"].join("\n")))).toBe(2);
  });

  it("falls back to top-level bullets for a proposal written as a list", () => {
    expect(
      requirementsIn(section(["- retry on 5xx", "  - with backoff", "- give up after five"].join("\n"))),
    ).toBe(2);
  });

  it("ignores headings and bullets inside a fenced block", () => {
    expect(
      requirementsIn(
        section(["```md", "### Requirement: not real", "- not real either", "```"].join("\n")),
      ),
    ).toBe(0);
  });
});

describe("the freshly scaffolded proposal", () => {
  // The exact template `keel spec new` writes.
  const scaffold = [
    "---",
    "status: draft",
    "---",
    "",
    "# add-webhook-retries",
    "",
    "## Why",
    "",
    "## What changes",
    "",
    "## ADDED Requirements",
    "",
    "## MODIFIED Requirements",
    "",
    "## REMOVED Requirements",
    "",
  ].join("\n");

  const sections = parseDelta(scaffold, "proposal.md");

  it("has three delta sections and no requirements", () => {
    expect(sections).toHaveLength(3);
    expect(countRequirements(sections).total).toBe(0);
  });

  it("no longer renders `+ 1 added · ~ 1 modified · - 1 removed` for an empty proposal", () => {
    const rendered = withRequirementCounts(renderDelta(proposal, sections), sections);
    expect(rendered).not.toContain("+ 1 added");
    expect(rendered).not.toContain("~ 1 modified");
    expect(rendered).not.toContain("- 1 removed");
    expect(rendered).toContain("No requirements yet");
    expect(rendered).toContain("3 empty delta sections");
  });

  it("counts real requirements once they are written", () => {
    const filled = scaffold.replace(
      "## ADDED Requirements\n",
      "## ADDED Requirements\n\n### Requirement: Retry on 5xx\n\nThe system SHALL retry.\n",
    );
    const withContent = parseDelta(filled, "proposal.md");
    const rendered = withRequirementCounts(renderDelta(proposal, withContent), withContent);
    expect(rendered).toContain("+ 1 added");
    expect(countRequirements(withContent).total).toBe(1);
  });
});

describe("summary rendering", () => {
  it("groups by kind", () => {
    const sections = [
      section("### Requirement: A"),
      { ...section("### Requirement: B"), kind: "MODIFIED" as const },
    ];
    expect(summariseRequirements(countRequirements(sections))).toBe("+ 1 added · ~ 1 modified");
  });

  it("leaves the rendered document alone when there are no sections at all", () => {
    const rendered = renderDelta(proposal, []);
    expect(withRequirementCounts(rendered, [])).toBe(rendered);
  });
});
