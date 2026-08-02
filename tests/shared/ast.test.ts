import { describe, expect, it } from "vitest";

import {
  extractCalls,
  extractSymbols,
  isPythonFile,
  isTypeScriptLike,
  literalText,
  loadTypeScript,
  parseSource,
} from "../../src/shared/ast/ts.js";

describe("file-kind detection", () => {
  it("recognises TypeScript-like extensions", () => {
    for (const p of ["a.ts", "a.tsx", "a.mts", "a.js", "a.jsx", "a.mjs", "a.cjs", "A.TS"]) {
      expect(isTypeScriptLike(p)).toBe(true);
    }
    for (const p of ["a.py", "a.md", "a.yaml", "a.rs"]) {
      expect(isTypeScriptLike(p)).toBe(false);
    }
  });

  it("recognises Python files", () => {
    expect(isPythonFile("x/y.py")).toBe(true);
    expect(isPythonFile("x/y.ts")).toBe(false);
  });
});

describe("lazy compiler load", () => {
  it("resolves the compiler and caches it", async () => {
    const first = await loadTypeScript();
    const second = await loadTypeScript();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});

describe("extractSymbols", () => {
  it("finds exported and non-exported declarations of every kind", async () => {
    const parsed = await parseSource(
      "m.ts",
      [
        "export function alpha(a: number): string { return String(a); }",
        "function hidden() { return 1; }",
        "export class Beta { m() {} }",
        "export interface Gamma { x: number }",
        "export type Delta = string | number;",
        "export enum Eps { A, B }",
        "export const zeta = (x: number) => x + 1;",
        "const priv = 2;",
        "export default alpha;",
      ].join("\n"),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;

    const symbols = extractSymbols(parsed);
    const byName = new Map(symbols.map((s) => [s.name, s]));

    expect(byName.get("alpha")?.kind).toBe("function");
    expect(byName.get("alpha")?.exported).toBe(true);
    expect(byName.get("hidden")?.exported).toBe(false);
    expect(byName.get("Beta")?.kind).toBe("class");
    expect(byName.get("Gamma")?.kind).toBe("interface");
    expect(byName.get("Delta")?.kind).toBe("type");
    expect(byName.get("Eps")?.kind).toBe("enum");
    expect(byName.get("zeta")?.exported).toBe(true);
    expect(byName.get("priv")?.exported).toBe(false);
    expect(byName.get("default")?.exported).toBe(true);
  });

  it("reports 1-based line numbers", async () => {
    const parsed = await parseSource("m.ts", "\n\nexport function f() {}\n");
    if (parsed === null) throw new Error("parse failed");
    expect(extractSymbols(parsed)[0]?.line).toBe(3);
  });

  it("excludes the body from a function signature so body edits do not read as API changes", async () => {
    const before = await parseSource("m.ts", "export function f(a: number): string { return 'a'; }");
    const after = await parseSource("m.ts", "export function f(a: number): string { return 'bbbb'; }");
    if (before === null || after === null) throw new Error("parse failed");
    expect(extractSymbols(before)[0]?.signature).toBe(extractSymbols(after)[0]?.signature);
  });

  it("detects a real signature change", async () => {
    const before = await parseSource("m.ts", "export function f(a: number): string { return 'a'; }");
    const after = await parseSource("m.ts", "export function f(a: number, b: string): string { return 'a'; }");
    if (before === null || after === null) throw new Error("parse failed");
    expect(extractSymbols(before)[0]?.signature).not.toBe(extractSymbols(after)[0]?.signature);
  });

  it("picks up named re-exports", async () => {
    const parsed = await parseSource("m.ts", "export { a, b } from './other.js';");
    if (parsed === null) throw new Error("parse failed");
    expect(extractSymbols(parsed).map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("parses TSX without choking on JSX", async () => {
    const parsed = await parseSource("c.tsx", "export const C = () => <div className=\"x\">hi</div>;");
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(extractSymbols(parsed)[0]?.name).toBe("C");
  });

  it("returns a parse result for syntactically broken input rather than throwing", async () => {
    const parsed = await parseSource("m.ts", "export function ( { ] ");
    expect(parsed).not.toBeNull();
  });
});

describe("extractCalls", () => {
  it("flattens dotted callees and captures argument text", async () => {
    const parsed = await parseSource(
      "t.test.ts",
      [
        "vi.mock('./refresh.js');",
        "describe('x', () => {",
        "  it('works', () => { expect(add(1, 2)).toBe(3); });",
        "});",
      ].join("\n"),
    );
    if (parsed === null) throw new Error("parse failed");

    const calls = extractCalls(parsed);
    const callees = calls.map((c) => c.callee);
    expect(callees).toContain("vi.mock");
    expect(callees).toContain("expect");
    expect(callees).toContain("describe");

    const mock = calls.find((c) => c.callee === "vi.mock");
    expect(mock?.args[0]).toBe("'./refresh.js'");
    expect(mock?.line).toBe(1);
  });
});

describe("literalText", () => {
  it("unwraps every quote style and rejects non-literals", () => {
    expect(literalText("'a/b'")).toBe("a/b");
    expect(literalText('"a/b"')).toBe("a/b");
    expect(literalText("`a/b`")).toBe("a/b");
    expect(literalText("someVar")).toBeNull();
    expect(literalText("'unterminated")).toBeNull();
  });
});
