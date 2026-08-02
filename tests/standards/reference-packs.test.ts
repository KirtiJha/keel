import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetRuleCache } from "../../src/standards/rule-loader.js";
import { runGates } from "../../src/standards/runner.js";

import { PLUGIN_ROOT, TempRepo } from "../helpers/temp-repo.js";

let repo: TempRepo;

beforeEach(() => {
  repo = TempRepo.create("keel-packs-");
  resetRuleCache();
});

afterEach(() => {
  repo.dispose();
});

async function check(path: string, source: string) {
  repo.write(path, source);
  return runGates({
    repoRoot: repo.root,
    pluginRoot: PLUGIN_ROOT,
    config: repo.config(),
    filePath: path,
  });
}

describe("no-raw-color-values", () => {
  it("flags a hex literal in a style object", async () => {
    const summary = await check(
      "src/ui/Card.tsx",
      ["export const styles = {", '  color: "#ff0044",', "};"].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.line).toBe(2);
    expect(summary.blocking[0]?.pack).toBe("no-raw-color-values");
    expect(summary.blocking[0]?.fix).toContain("token");
  });

  it.each([
    ["3-digit hex", '"#f04"'],
    ["6-digit hex", '"#ff0044"'],
    ["8-digit hex with alpha", '"#ff0044cc"'],
    ["rgb()", '"rgb(255, 0, 68)"'],
    ["rgba()", '"rgba(255, 0, 68, 0.5)"'],
    ["hsl()", '"hsl(340, 100%, 50%)"'],
    ["oklch()", '"oklch(70% 0.1 20)"'],
  ])("flags %s", async (_name, literal) => {
    const summary = await check(
      "src/ui/Card.tsx",
      ["export const styles = {", `  backgroundColor: ${literal},`, "};"].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
  });

  it("flags raw colours inside a styled-components template", async () => {
    const summary = await check(
      "src/ui/Button.tsx",
      [
        "import styled from 'styled-components';",
        "export const Button = styled.button`",
        "  color: #ffffff;",
        "  padding: 8px;",
        "`;",
      ].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.line).toBe(3);
  });

  it("accepts a token reference", async () => {
    const summary = await check(
      "src/ui/Card.tsx",
      ["import { tokens } from './tokens.js';", "export const styles = {", "  color: tokens.color.danger,", "};"].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("accepts keywords that are not design decisions", async () => {
    const summary = await check(
      "src/ui/Card.tsx",
      ["export const styles = {", '  backgroundColor: "transparent",', '  color: "inherit",', "};"].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("does not flag a hex-looking string in a non-colour property", async () => {
    // This is the case a regex-only rule gets wrong.
    const summary = await check(
      "src/ui/Card.tsx",
      [
        "export const meta = {",
        '  commit: "#a1b2c3",',
        '  anchor: "#section-1",',
        '  id: "#ff0044",',
        "};",
      ].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("does not flag a hex value in a comment", async () => {
    const summary = await check(
      "src/ui/Card.tsx",
      ["// brand red used to be #ff0044", "export const styles = { color: tokens.color.brand };"].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("does not flag a non-colour CSS property in a template", async () => {
    const summary = await check(
      "src/ui/Button.tsx",
      ["import styled from 'styled-components';", "export const B = styled.button`", "  padding: 8px;", "`;"].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });
});

describe("error-envelope — TypeScript", () => {
  it("flags a bare error object returned from a handler", async () => {
    const summary = await check(
      "services/api/handlers/charge.ts",
      [
        "export function handleCharge(): unknown {",
        '  return { error: "insufficient funds" };',
        "}",
      ].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.pack).toBe("error-envelope");
    expect(summary.blocking[0]?.line).toBe(2);
  });

  it("flags a bare error object passed to res.json", async () => {
    const summary = await check(
      "services/api/handlers/charge.ts",
      [
        "export function handleCharge(res: { status: (n: number) => { json: (b: unknown) => void } }): void {",
        '  res.status(500).json({ message: "boom" });',
        "}",
      ].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
  });

  it("accepts a call to the envelope factory", async () => {
    const summary = await check(
      "services/api/handlers/charge.ts",
      [
        "import { errorResponse } from '../envelope.js';",
        "export function handleCharge(): unknown {",
        '  return errorResponse("insufficient_funds", "Insufficient funds");',
        "}",
      ].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("accepts an object that spreads the envelope factory", async () => {
    const summary = await check(
      "services/api/handlers/charge.ts",
      [
        "import { errorResponse } from '../envelope.js';",
        "export function handleCharge(traceId: string): unknown {",
        '  return { ...errorResponse("x", "y"), traceId };',
        "}",
      ].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("accepts a success payload with no error keys", async () => {
    const summary = await check(
      "services/api/handlers/charge.ts",
      ["export function handleCharge(): unknown {", "  return { id: 1, amount: 250 };", "}"].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("does not apply outside handler and route paths", async () => {
    const summary = await check(
      "src/lib/util.ts",
      ["export function f(): unknown {", '  return { error: "nope" };', "}"].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });
});

describe("error-envelope — Python", () => {
  it("flags a bare error dict returned from a handler", async () => {
    const summary = await check(
      "services/api/handlers/charge.py",
      ["def handle_charge() -> dict[str, str]:", '    return {"error": "insufficient funds"}'].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.pack).toBe("error-envelope");
    expect(summary.blocking[0]?.line).toBe(2);
  });

  it("flags a bare error dict passed to JSONResponse", async () => {
    const summary = await check(
      "services/api/handlers/charge.py",
      [
        "from fastapi.responses import JSONResponse",
        "",
        "",
        "def handle_charge() -> JSONResponse:",
        '    return JSONResponse({"detail": "boom"}, status_code=500)',
      ].join("\n"),
    );
    expect(summary.blocking).toHaveLength(1);
    expect(summary.blocking[0]?.line).toBe(5);
  });

  it("accepts a call to the envelope factory", async () => {
    const summary = await check(
      "services/api/handlers/charge.py",
      [
        "from ..envelope import error_response",
        "",
        "",
        "def handle_charge() -> dict[str, str]:",
        '    return error_response("insufficient_funds", "Insufficient funds")',
      ].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("accepts a dict that unpacks the envelope factory", async () => {
    const summary = await check(
      "services/api/handlers/charge.py",
      [
        "from ..envelope import error_response",
        "",
        "",
        "def handle_charge(trace_id: str) -> dict[str, str]:",
        '    return {**error_response("x", "y"), "trace_id": trace_id}',
      ].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("accepts a success dict with no error keys", async () => {
    const summary = await check(
      "services/api/handlers/charge.py",
      ["def handle_charge() -> dict[str, int]:", '    return {"id": 1, "amount": 250}'].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });

  it("returns no findings for a file that does not parse, rather than crashing", async () => {
    const summary = await check(
      "services/api/handlers/charge.py",
      ["def handle_charge(  ->", '    return {"error": 1}'].join("\n"),
    );
    expect(summary.blocking).toEqual([]);
  });
});
