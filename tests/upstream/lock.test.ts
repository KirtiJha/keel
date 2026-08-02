import { describe, expect, it } from "vitest";

import { installable, loadLock, validateLock, type UpstreamLock } from "../../src/upstream/lock.js";

import { PLUGIN_ROOT } from "../helpers/temp-repo.js";

function lock(dependencies: Record<string, unknown>): UpstreamLock {
  return { version: 1, dependencies } as UpstreamLock;
}

const PINNED = {
  version: "1.0.0",
  source: "x/y",
  role: "install" as const,
  mirror: "internal/y@1.0.0",
  owns: [] as string[],
};

describe("version pinning", () => {
  it("accepts an exact version", () => {
    expect(validateLock(lock({ y: PINNED })).filter((i) => i.severity === "error")).toEqual([]);
  });

  it.each(["UNPINNED", "latest", "main", "master", "HEAD", "*"])(
    "rejects the moving version %s",
    (version) => {
      const issues = validateLock(lock({ y: { ...PINNED, version } }));
      expect(issues.some((i) => i.severity === "error")).toBe(true);
    },
  );

  it.each(["^1.2.0", "~1.2.0"])("rejects the floating range %s", (version) => {
    const issues = validateLock(lock({ y: { ...PINNED, version } }));
    const issue = issues.find((i) => i.severity === "error");
    expect(issue?.message).toContain("floating range");
    expect(issue?.fix).toContain("1.2.0");
  });

  it("names the human input for UNPINNED", () => {
    const issue = validateLock(lock({ y: { ...PINNED, version: "UNPINNED" } }))[0];
    expect(issue?.fix).toContain("ask the owning team");
  });

  it("warns, but does not fail, on a missing mirror", () => {
    const issues = validateLock(lock({ y: { version: "1.0.0", source: "x/y", role: "install", owns: [] } }));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => i.severity === "warning" && i.message.includes("mirror"))).toBe(true);
  });

  it("does not ask a pattern source for a mirror — it is never fetched", () => {
    const issues = validateLock(
      lock({ y: { version: "1.0.0", source: "x/y", role: "pattern-source", owns: [] } }),
    );
    expect(issues).toEqual([]);
  });
});

describe("phase ownership", () => {
  it("accepts a dependency owning the phases the map assigns it", () => {
    const issues = validateLock(
      lock({
        superpowers: { ...PINNED, source: "obra/superpowers", owns: ["planning", "implementation"] },
        openspec: { ...PINNED, source: "@fission-ai/openspec", owns: ["design", "spec-conformance"] },
      }),
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("rejects a dependency claiming a phase the map assigns elsewhere", () => {
    const issues = validateLock(lock({ superpowers: { ...PINNED, owns: ["design"] } }));
    const issue = issues.find((i) => i.message.includes("design"));
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("openspec");
    expect(issue?.fix).toContain("one owner per phase");
  });

  it("rejects two dependencies claiming the same phase", () => {
    // Both name themselves `superpowers`-legal owners of planning is impossible,
    // so use the composite-owner phase, which legitimately lists two names.
    const issues = validateLock(
      lock({
        openspec: { ...PINNED, owns: ["spec-conformance"] },
        "builtin-spec-validation": { ...PINNED, owns: ["spec-conformance"] },
      }),
    );
    const conflict = issues.find((i) => i.message.includes("claimed by 2 dependencies"));
    expect(conflict?.severity).toBe("error");
    expect(conflict?.message).toContain("openspec");
    expect(conflict?.message).toContain("builtin-spec-validation");
  });

  it("rejects an unknown phase and lists the real ones", () => {
    const issue = validateLock(lock({ y: { ...PINNED, owns: ["refactoring"] } }))[0];
    expect(issue?.message).toContain("refactoring");
    expect(issue?.fix).toContain("classification");
  });

  it("rejects a pattern source that claims a phase", () => {
    const issues = validateLock(
      lock({ "spec-kit": { ...PINNED, role: "pattern-source", owns: ["design"] } }),
    );
    const issue = issues.find((i) => i.message.includes("pattern-source"));
    expect(issue?.severity).toBe("error");
    expect(issue?.fix).toContain("owns: []");
  });
});

describe("installable", () => {
  it("excludes pattern sources", () => {
    const names = installable(
      lock({
        superpowers: { ...PINNED, owns: ["planning", "implementation"] },
        "spec-kit": { ...PINNED, role: "pattern-source" },
      }),
    ).map(([name]) => name);

    expect(names).toEqual(["superpowers"]);
  });
});

describe("this repository's upstream.lock", () => {
  it("parses", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    expect(loaded.ok, loaded.ok ? "" : loaded.error).toBe(true);
  });

  it("pins every dependency to an exact version", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    if (!loaded.ok) throw new Error(loaded.error);

    for (const [name, dependency] of Object.entries(loaded.value.dependencies)) {
      expect(dependency.version, `${name} must be pinned`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("has no phase-ownership errors — only the outstanding mirrors", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    if (!loaded.ok) throw new Error(loaded.error);

    const issues = validateLock(loaded.value);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    // Mirrors are still to be set up; that is a warning by design.
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("keeps spec-kit as a pattern source, so it cannot contend for a phase", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    if (!loaded.ok) throw new Error(loaded.error);

    const specKit = loaded.value.dependencies["spec-kit"];
    expect(specKit?.role).toBe("pattern-source");
    expect(specKit?.owns).toEqual([]);
    expect(installable(loaded.value).map(([n]) => n)).not.toContain("spec-kit");
  });

  it("declares an owner for every phase Keel does not own itself", () => {
    const loaded = loadLock(PLUGIN_ROOT);
    if (!loaded.ok) throw new Error(loaded.error);

    const owned = new Set(
      Object.values(loaded.value.dependencies).flatMap((d) => d.owns),
    );
    expect(owned).toContain("planning");
    expect(owned).toContain("implementation");
    expect(owned).toContain("design");
    expect(owned).toContain("spec-conformance");
  });
});
