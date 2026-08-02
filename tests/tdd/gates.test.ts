import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyseTests } from "../../src/tdd/analysis.js";
import {
  gateAssertionLint,
  gateMockUnderTest,
  gateObservedRed,
  gateTestWeakening,
} from "../../src/tdd/gates.js";
import { findOverrides } from "../../src/tdd/vocabulary.js";
import { isTestFile, specifierTargetsModule, stemOf, testCandidatesFor } from "../../src/tdd/pairing.js";
import { defaultConfig } from "../../src/shared/config.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

/**
 * M6 acceptance: "for each gate, a fixture pair (violating and clean) in both
 * TypeScript and Python."
 */

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-tdd-");
});

afterEach(() => {
  repo.dispose();
});

const analyse = (path: string, source: string) => analyseTests(PLUGIN_ROOT, path, source);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

describe("test-file analysis — TypeScript", () => {
  it("counts tests, assertions and matchers", async () => {
    const a = await analyse(
      "src/a.test.ts",
      [
        "describe('add', () => {",
        "  it('adds', () => { expect(add(1, 2)).toBe(3); });",
        "  it('handles zero', () => { expect(add(0, 0)).toBe(0); expect(add(0, 1)).toEqual(1); });",
        "});",
      ].join("\n"),
    );

    expect(a.tests).toHaveLength(2);
    expect(a.totalAssertions).toBe(3);
    expect(a.matchers).toEqual(["toBe", "toBe", "toEqual"]);
    expect(a.tests[0]?.assertions).toBe(1);
    expect(a.tests[1]?.assertions).toBe(2);
  });

  it("sees through .not and .resolves to the real matcher", async () => {
    const a = await analyse(
      "src/a.test.ts",
      [
        "it('a', () => { expect(x).not.toBe(1); });",
        "it('b', async () => { await expect(p).resolves.toEqual(2); });",
      ].join("\n"),
    );
    expect(a.matchers).toEqual(["toBe", "toEqual"]);
  });

  it("detects skip and only markers", async () => {
    const a = await analyse(
      "src/a.test.ts",
      [
        "it.skip('skipped', () => { expect(1).toBe(1); });",
        "it.only('focused', () => { expect(1).toBe(1); });",
        "xit('x-skipped', () => { expect(1).toBe(1); });",
      ].join("\n"),
    );
    expect(a.tests.find((t) => t.name === "skipped")?.skipped).toBe(true);
    expect(a.tests.find((t) => t.name === "focused")?.focused).toBe(true);
    expect(a.tests.find((t) => t.name === "x-skipped")?.skipped).toBe(true);
  });

  it("attributes assertions to a table-driven it.each test", async () => {
    // `it.each(table)(name, fn)` is curried. Reading the inner call as the test
    // makes every table-driven test look assertion-free.
    const a = await analyse(
      "src/a.test.ts",
      [
        "it.each([[1, 2, 3], [2, 2, 4]])('adds %i + %i', (x, y, expected) => {",
        "  expect(add(x, y)).toBe(expected);",
        "});",
      ].join("\n"),
    );

    expect(a.tests).toHaveLength(1);
    expect(a.tests[0]?.name).toBe("adds %i + %i");
    expect(a.tests[0]?.assertions).toBe(1);
    expect(gateAssertionLint(a).violations).toEqual([]);
  });

  it("handles describe.each and it.each.skip", async () => {
    const a = await analyse(
      "src/a.test.ts",
      [
        "describe.each([1, 2])('group %i', (n) => {",
        "  it('works', () => { expect(n).toBe(n); });",
        "});",
      ].join("\n"),
    );
    expect(a.tests.map((t) => t.name)).toContain("works");
    expect(gateAssertionLint(a).violations).toEqual([]);
  });

  it("records mocked module specifiers", async () => {
    const a = await analyse(
      "src/a.test.ts",
      ["vi.mock('./refresh.js');", "jest.mock('../auth/token');"].join("\n"),
    );
    expect(a.mockedModules).toEqual(["./refresh.js", "../auth/token"]);
  });
});

describe("test-file analysis — Python", () => {
  it("counts tests, bare asserts and unittest matchers", async () => {
    const a = await analyse(
      "tests/test_a.py",
      [
        "def test_adds():",
        "    assert add(1, 2) == 3",
        "",
        "",
        "class TestThing:",
        "    def test_zero(self):",
        "        self.assertEqual(add(0, 0), 0)",
        "        assert add(0, 1) == 1",
      ].join("\n"),
    );

    expect(a.tests).toHaveLength(2);
    expect(a.totalAssertions).toBe(3);
    expect(a.matchers).toContain("assertEqual");
    expect(a.matchers).toContain("assert");
  });

  it("detects pytest skip decorators", async () => {
    const a = await analyse(
      "tests/test_a.py",
      ["import pytest", "", "", "@pytest.mark.skip", "def test_off():", "    assert True"].join("\n"),
    );
    expect(a.tests[0]?.skipped).toBe(true);
  });

  it("records patched targets", async () => {
    const a = await analyse(
      "tests/test_a.py",
      [
        "from unittest.mock import patch",
        "",
        "",
        "def test_x():",
        "    with patch('app.service.charge'):",
        "        assert True",
      ].join("\n"),
    );
    expect(a.mockedModules).toContain("app.service.charge");
  });

  it("reports unparsed for a file mid-edit rather than crashing", async () => {
    const a = await analyse("tests/test_a.py", "def test_x(  ->\n");
    expect(a.unparsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 1 — test weakening
// ---------------------------------------------------------------------------

describe("gate 1 — test weakening (TypeScript)", () => {
  const CLEAN = [
    "it('adds', () => { expect(add(1, 2)).toBe(3); });",
    "it('subtracts', () => { expect(sub(3, 1)).toBe(2); });",
  ].join("\n");

  async function run(before: string, after: string) {
    return gateTestWeakening(
      await analyse("src/a.test.ts", before),
      await analyse("src/a.test.ts", after),
      findOverrides(after),
      "typescript",
    );
  }

  it("passes an unchanged file", async () => {
    expect((await run(CLEAN, CLEAN)).violations).toEqual([]);
  });

  it("passes a file that gains a test", async () => {
    const after = `${CLEAN}\nit('multiplies', () => { expect(mul(2, 3)).toBe(6); });`;
    expect((await run(CLEAN, after)).violations).toEqual([]);
  });

  it("blocks a removed test", async () => {
    const after = "it('adds', () => { expect(add(1, 2)).toBe(3); });";
    const outcome = await run(CLEAN, after);
    expect(outcome.violations.some((v) => v.message.includes("removed"))).toBe(true);
  });

  it("blocks a dropped assertion", async () => {
    const before = "it('adds', () => { expect(add(1, 2)).toBe(3); expect(add(2, 2)).toBe(4); });";
    const after = "it('adds', () => { expect(add(1, 2)).toBe(3); });";
    const outcome = await run(before, after);
    expect(outcome.violations.some((v) => v.message.includes("assertion count fell"))).toBe(true);
  });

  it("blocks a loosened matcher", async () => {
    const before = "it('adds', () => { expect(add(1, 2)).toBe(3); });";
    const after = "it('adds', () => { expect(add(1, 2)).toBeTruthy(); });";
    const outcome = await run(before, after);
    expect(outcome.violations.some((v) => v.message.includes("matcher loosened"))).toBe(true);
    expect(outcome.violations[0]?.message).toContain("toBe");
    expect(outcome.violations[0]?.message).toContain("toBeTruthy");
  });

  it("blocks a newly skipped test", async () => {
    const after = CLEAN.replace("it('subtracts'", "it.skip('subtracts'");
    const outcome = await run(CLEAN, after);
    expect(outcome.violations.some((v) => v.message.includes("marked skipped"))).toBe(true);
  });

  it("blocks a newly focused test, because .only silently skips its siblings", async () => {
    const after = CLEAN.replace("it('adds'", "it.only('adds'");
    const outcome = await run(CLEAN, after);
    expect(outcome.violations.some((v) => v.message.includes(".only"))).toBe(true);
  });

  it("honours an override comment carrying a reason", async () => {
    const after = "// keel: allow-test-change the subtract behaviour moved to another module\nit('adds', () => { expect(add(1, 2)).toBe(3); });";
    const outcome = await run(CLEAN, after);
    expect(outcome.violations).toEqual([]);
    expect(outcome.overridden).toBe(true);
    expect(outcome.overrideReasons[0]).toContain("moved to another module");
  });

  it("ignores a bare override marker with no reason", async () => {
    const after = "// keel: allow-test-change\nit('adds', () => { expect(add(1, 2)).toBe(3); });";
    const outcome = await run(CLEAN, after);
    expect(outcome.violations.length).toBeGreaterThan(0);
    expect(outcome.overridden).toBe(false);
  });
});

describe("gate 1 — test weakening (Python)", () => {
  const CLEAN = [
    "def test_adds():",
    "    assert add(1, 2) == 3",
    "",
    "",
    "def test_subtracts():",
    "    assert sub(3, 1) == 2",
  ].join("\n");

  async function run(before: string, after: string) {
    return gateTestWeakening(
      await analyse("tests/test_a.py", before),
      await analyse("tests/test_a.py", after),
      findOverrides(after),
      "python",
    );
  }

  it("passes an unchanged file", async () => {
    expect((await run(CLEAN, CLEAN)).violations).toEqual([]);
  });

  it("blocks a removed test", async () => {
    const after = ["def test_adds():", "    assert add(1, 2) == 3"].join("\n");
    expect((await run(CLEAN, after)).violations.some((v) => v.message.includes("removed"))).toBe(true);
  });

  it("blocks assertEqual downgraded to assertTrue", async () => {
    const before = ["def test_adds(self):", "    self.assertEqual(add(1, 2), 3)"].join("\n");
    const after = ["def test_adds(self):", "    self.assertTrue(add(1, 2))"].join("\n");
    const outcome = await run(before, after);
    expect(outcome.violations.some((v) => v.message.includes("matcher loosened"))).toBe(true);
  });

  it("blocks a newly skipped test", async () => {
    const after = ["import pytest", "", "", "@pytest.mark.skip", ...CLEAN.split("\n")].join("\n");
    expect((await run(CLEAN, after)).violations.some((v) => v.message.includes("skipped"))).toBe(true);
  });

  it("honours a python override comment", async () => {
    const after = [
      "# keel: allow-test-change subtract moved to the arithmetic module",
      "def test_adds():",
      "    assert add(1, 2) == 3",
    ].join("\n");
    const outcome = await run(CLEAN, after);
    expect(outcome.violations).toEqual([]);
    expect(outcome.overridden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — mocking the unit under test
// ---------------------------------------------------------------------------

describe("gate 2 — mocking the unit under test", () => {
  it("blocks a TypeScript test that mocks its own module", async () => {
    const analysis = await analyse(
      "src/auth/refresh.test.ts",
      ["vi.mock('./refresh.js');", "it('a', () => { expect(1).toBe(1); });"].join("\n"),
    );
    const outcome = gateMockUnderTest("src/auth/refresh.test.ts", analysis);
    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0]?.message).toContain("mocks the module it is testing");
  });

  it("allows mocking a collaborator", async () => {
    const analysis = await analyse(
      "src/auth/refresh.test.ts",
      ["vi.mock('../http/client.js');", "it('a', () => { expect(1).toBe(1); });"].join("\n"),
    );
    expect(gateMockUnderTest("src/auth/refresh.test.ts", analysis).violations).toEqual([]);
  });

  it("blocks a Python test that patches its own module", async () => {
    const analysis = await analyse(
      "tests/test_service.py",
      [
        "from unittest.mock import patch",
        "",
        "",
        "def test_x():",
        "    with patch('app.service.charge'):",
        "        assert True",
      ].join("\n"),
    );
    // `app.service` -> stem `service`, matching test_service.py.
    const outcome = gateMockUnderTest("tests/test_service.py", analysis);
    expect(outcome.violations).toEqual([]);

    const direct = await analyse(
      "tests/test_service.py",
      ["from unittest.mock import patch", "", "", "def test_x():", "    with patch('app.service'):", "        assert True"].join("\n"),
    );
    expect(gateMockUnderTest("tests/test_service.py", direct).violations).toHaveLength(1);
  });

  it("allows a Python test that patches a collaborator", async () => {
    const analysis = await analyse(
      "tests/test_service.py",
      ["from unittest.mock import patch", "", "", "def test_x():", "    with patch('app.gateway'):", "        assert True"].join("\n"),
    );
    expect(gateMockUnderTest("tests/test_service.py", analysis).violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — observed RED
// ---------------------------------------------------------------------------

describe("gate 3 — observed RED", () => {
  it("passes when no new symbols were added", () => {
    const outcome = gateObservedRed([], { observed: false, testFile: null, reason: "x" }, "src/a.ts");
    expect(outcome.violations).toEqual([]);
  });

  it("passes when red was observed", () => {
    const outcome = gateObservedRed(
      ["newThing"],
      { observed: true, testFile: "src/a.test.ts", reason: "red observed" },
      "src/a.ts",
    );
    expect(outcome.violations).toEqual([]);
  });

  it("blocks a new symbol with no failing run, naming the test to run", () => {
    const outcome = gateObservedRed(
      ["newThing"],
      { observed: false, testFile: "src/a.test.ts", reason: "the test has not been seen failing yet" },
      "src/a.ts",
    );
    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0]?.message).toContain("newThing");
    expect(outcome.violations[0]?.fix).toContain("src/a.test.ts");
    expect(outcome.violations[0]?.fix).toContain("--spike");
  });

  it("tells you to write a test when none exists", () => {
    const outcome = gateObservedRed(
      ["newThing"],
      { observed: false, testFile: null, reason: "no test file exists for this module" },
      "src/a.ts",
    );
    expect(outcome.violations[0]?.fix).toContain("write a test");
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — assertion lint
// ---------------------------------------------------------------------------

describe("gate 4 — assertion lint (TypeScript)", () => {
  it("passes a test with a real assertion", async () => {
    const a = await analyse("src/a.test.ts", "it('adds', () => { expect(add(1, 2)).toBe(3); });");
    expect(gateAssertionLint(a).violations).toEqual([]);
  });

  it("blocks an assertion-free test", async () => {
    const a = await analyse("src/a.test.ts", "it('does something', () => { add(1, 2); });");
    const outcome = gateAssertionLint(a);
    expect(outcome.violations).toHaveLength(1);
    expect(outcome.violations[0]?.message).toContain("asserts nothing");
  });

  it("blocks a snapshot-only test", async () => {
    const a = await analyse("src/a.test.ts", "it('renders', () => { expect(render()).toMatchSnapshot(); });");
    expect(gateAssertionLint(a).violations[0]?.message).toContain("snapshot");
  });

  it("blocks a truthiness-only test", async () => {
    const a = await analyse("src/a.test.ts", "it('works', () => { expect(add(1, 2)).toBeTruthy(); });");
    expect(gateAssertionLint(a).violations[0]?.message).toContain("truthiness");
  });

  it("allows a truthy assertion alongside a real one", async () => {
    const a = await analyse(
      "src/a.test.ts",
      "it('works', () => { expect(r).toBeDefined(); expect(r.total).toBe(3); });",
    );
    expect(gateAssertionLint(a).violations).toEqual([]);
  });

  it("ignores a skipped test", async () => {
    const a = await analyse("src/a.test.ts", "it.skip('later', () => {});");
    expect(gateAssertionLint(a).violations).toEqual([]);
  });
});

describe("gate 4 — assertion lint (Python)", () => {
  it("passes a test with a real assertion", async () => {
    const a = await analyse("tests/test_a.py", "def test_adds():\n    assert add(1, 2) == 3\n");
    expect(gateAssertionLint(a).violations).toEqual([]);
  });

  it("blocks an assertion-free test", async () => {
    const a = await analyse("tests/test_a.py", "def test_adds():\n    add(1, 2)\n");
    expect(gateAssertionLint(a).violations[0]?.message).toContain("asserts nothing");
  });

  it("blocks an assertTrue-only test", async () => {
    const a = await analyse("tests/test_a.py", "def test_adds(self):\n    self.assertTrue(add(1, 2))\n");
    expect(gateAssertionLint(a).violations[0]?.message).toContain("truthiness");
  });
});

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

describe("source/test pairing", () => {
  it("strips test affixes from a stem", () => {
    expect(stemOf("src/auth/refresh.test.ts")).toBe("refresh");
    expect(stemOf("src/auth/refresh.spec.tsx")).toBe("refresh");
    expect(stemOf("tests/test_models.py")).toBe("models");
    expect(stemOf("app/models_test.py")).toBe("models");
  });

  it("proposes conventional test locations", () => {
    const candidates = testCandidatesFor("src/auth/refresh.ts");
    expect(candidates).toContain("src/auth/refresh.test.ts");
    expect(candidates).toContain("src/auth/__tests__/refresh.test.ts");
    expect(candidates).toContain("tests/auth/refresh.test.ts");
  });

  it("proposes conventional python test locations", () => {
    const candidates = testCandidatesFor("app/models.py");
    expect(candidates).toContain("app/test_models.py");
    expect(candidates).toContain("tests/test_models.py");
  });

  it("matches specifiers to the module under test by stem", () => {
    expect(specifierTargetsModule("./refresh.js", "src/auth/refresh.test.ts")).toBe(true);
    expect(specifierTargetsModule("../auth/refresh", "src/auth/refresh.test.ts")).toBe(true);
    expect(specifierTargetsModule("app.auth.refresh", "tests/test_refresh.py")).toBe(true);
    expect(specifierTargetsModule("./client.js", "src/auth/refresh.test.ts")).toBe(false);
  });

  it("recognises test files from the configured globs", () => {
    const globs = defaultConfig("x", ["typescript", "python"]).tdd.test_globs;
    expect(isTestFile("src/a.test.ts", globs)).toBe(true);
    expect(isTestFile("tests/test_a.py", globs)).toBe(true);
    expect(isTestFile("src/a.ts", globs)).toBe(false);
  });
});
