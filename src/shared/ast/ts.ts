import type * as TS from "typescript";

/**
 * Lazy wrapper around the TypeScript compiler API.
 *
 * Evaluating `typescript` costs ~400 ms (measured on Node 22), which is why it
 * is `external` in the bundle and imported through here rather than at module
 * top level. Nothing loads it until a caller actually needs a TS/JS AST — a
 * hook that only matches paths, or one that sees a `.py` or `.md` file, pays
 * nothing.
 *
 * The type-only import above is erased at build time and creates no runtime
 * dependency.
 */

let cached: typeof TS | null | undefined;

export async function loadTypeScript(): Promise<typeof TS | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("typescript")) as unknown as { default?: typeof TS };
    cached = mod.default ?? (mod as unknown as typeof TS);
  } catch {
    // Missing compiler must degrade to "no AST findings", never to a crash.
    cached = null;
  }
  return cached;
}

/** Reset the module cache. Test-only seam; production never calls this. */
export function resetTypeScriptCache(): void {
  cached = undefined;
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function isTypeScriptLike(path: string): boolean {
  return TS_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

export function isPythonFile(path: string): boolean {
  return path.toLowerCase().endsWith(".py");
}

export interface ParsedSource {
  readonly ts: typeof TS;
  readonly sourceFile: TS.SourceFile;
  /** 1-based line for a character offset. */
  lineOf(pos: number): number;
  /** 1-based column for a character offset. */
  columnOf(pos: number): number;
}

/** Parse without type-checking. `createSourceFile` is ~1–3 ms for typical files. */
export async function parseSource(
  fileName: string,
  text: string,
): Promise<ParsedSource | null> {
  const ts = await loadTypeScript();
  if (ts === null) return null;
  try {
    const isTsx = fileName.endsWith(".tsx") || fileName.endsWith(".jsx");
    const sourceFile = ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      isTsx ? ts.ScriptKind.TSX : undefined,
    );
    return {
      ts,
      sourceFile,
      lineOf: (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1,
      columnOf: (pos) => sourceFile.getLineAndCharacterOfPosition(pos).character + 1,
    };
  } catch {
    return null;
  }
}

/** Depth-first walk. Returning `false` from `visit` prunes that subtree. */
export function walk(node: TS.Node, visit: (n: TS.Node) => boolean | void): void {
  const stack: TS.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (visit(current) === false) continue;
    const children: TS.Node[] = [];
    current.forEachChild((child) => {
      children.push(child);
    });
    // Push reversed so the walk visits children left-to-right.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) stack.push(child);
    }
  }
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "default";

export interface SymbolRef {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly exported: boolean;
  /**
   * Normalised declaration header. Compared before/after to decide whether a
   * public signature changed (router rule 3), so it must exclude the body.
   */
  readonly signature: string;
}

function hasExportModifier(ts: typeof TS, node: TS.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function signatureOf(ts: typeof TS, node: TS.Node, sf: TS.SourceFile): string {
  // For anything with a body, the signature is everything before the body.
  const withBody = node as { body?: TS.Node };
  if (withBody.body !== undefined) {
    const start = node.getStart(sf);
    const end = withBody.body.getStart(sf);
    return normalise(sf.text.slice(start, end));
  }
  return normalise(node.getText(sf));
}

/**
 * Declared symbols in a source file, exported ones flagged.
 *
 * Deliberately syntactic: no type checker, no program, no module resolution.
 * That keeps it to a single-file parse, which is what makes it affordable.
 */
export function extractSymbols(parsed: ParsedSource): SymbolRef[] {
  const { ts, sourceFile } = parsed;
  const out: SymbolRef[] = [];

  const push = (name: string, kind: SymbolKind, node: TS.Node, exported: boolean): void => {
    out.push({
      name,
      kind,
      line: parsed.lineOf(node.getStart(sourceFile)),
      exported,
      signature: signatureOf(ts, node, sourceFile),
    });
  };

  // Only top-level statements declare module-visible symbols.
  for (const statement of sourceFile.statements) {
    const exported = hasExportModifier(ts, statement);

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      push(statement.name.text, "function", statement, exported);
    } else if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      push(statement.name.text, "class", statement, exported);
    } else if (ts.isInterfaceDeclaration(statement)) {
      push(statement.name.text, "interface", statement, exported);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      push(statement.name.text, "type", statement, exported);
    } else if (ts.isEnumDeclaration(statement)) {
      push(statement.name.text, "enum", statement, exported);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          // Signature for a const arrow function is its parameter list, not the body.
          push(decl.name.text, "variable", decl, exported);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      push("default", "default", statement, true);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          push(el.name.text, "variable", el, true);
        }
      }
    }
  }

  return out;
}

export interface CallRef {
  /** Dotted callee text, e.g. `expect`, `vi.mock`, `jest.spyOn`. */
  readonly callee: string;
  readonly line: number;
  readonly node: TS.CallExpression;
  /** Source text of each argument, trimmed. */
  readonly args: readonly string[];
}

/** Every call expression in the file, with a flattened callee name. */
export function extractCalls(parsed: ParsedSource): CallRef[] {
  const { ts, sourceFile } = parsed;
  const out: CallRef[] = [];

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    out.push({
      callee: normalise(node.expression.getText(sourceFile)),
      line: parsed.lineOf(node.getStart(sourceFile)),
      node,
      args: node.arguments.map((a) => normalise(a.getText(sourceFile))),
    });
  });

  return out;
}

/** Strip quotes from a string-literal argument, returning null if it is not one. */
export function literalText(arg: string): string | null {
  const m = /^(['"`])([\s\S]*)\1$/.exec(arg);
  return m === null ? null : (m[2] ?? null);
}
