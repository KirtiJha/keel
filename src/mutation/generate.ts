import type * as TS from "typescript";

import { exec, pythonBin } from "../shared/exec.js";
import { isPythonFile, isTypeScriptLike, parseSource, walk } from "../shared/ast/ts.js";

import { BINARY_MUTATIONS, type Mutant, type OperatorName } from "./operators.js";

/**
 * Generating mutants from an AST.
 *
 * AST-driven rather than text-driven, for the same reason the colour gate is:
 * a regex would mutate the `+` inside a string literal, a comment, or a version
 * number, producing mutants no test can kill and a score that means nothing.
 */

export interface GenerateOptions {
  /** Only mutate these 1-based lines. Empty means "no lines changed". */
  readonly changedLines: ReadonlySet<number>;
  readonly pluginRoot: string;
}

/** Mutants for one TypeScript/JavaScript file. */
export async function generateTypeScriptMutants(
  file: string,
  source: string,
  options: GenerateOptions,
): Promise<Mutant[]> {
  const parsed = await parseSource(file, source);
  if (parsed === null) return [];

  const { ts, sourceFile } = parsed;
  const mutants: Mutant[] = [];

  const push = (
    start: number,
    end: number,
    replacement: string,
    operator: OperatorName,
  ): void => {
    const line = parsed.lineOf(start);
    // Diff-only, exactly as the gate runner does it.
    if (!options.changedLines.has(line)) return;
    const original = source.slice(start, end);
    if (original === replacement) return;
    mutants.push({ file, line, operator, start, end, replacement, original });
  };

  walk(sourceFile, (node) => {
    // ---- binary operators ----
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const text = source.slice(token.getStart(sourceFile), token.getEnd());
      const mutation = BINARY_MUTATIONS[text];
      if (mutation !== undefined) {
        push(token.getStart(sourceFile), token.getEnd(), mutation.to, mutation.operator);
      }
    }

    // ---- boolean literals ----
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      push(node.getStart(sourceFile), node.getEnd(), "false", "boolean-literal");
    } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
      push(node.getStart(sourceFile), node.getEnd(), "true", "boolean-literal");
    }

    // ---- ++ / -- ----
    if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
      const unary = node as TS.PrefixUnaryExpression | TS.PostfixUnaryExpression;
      if (unary.operator === ts.SyntaxKind.PlusPlusToken) {
        const text = source.slice(node.getStart(sourceFile), node.getEnd());
        push(node.getStart(sourceFile), node.getEnd(), text.replace("++", "--"), "increment");
      } else if (unary.operator === ts.SyntaxKind.MinusMinusToken) {
        const text = source.slice(node.getStart(sourceFile), node.getEnd());
        push(node.getStart(sourceFile), node.getEnd(), text.replace("--", "++"), "increment");
      }
    }

    // ---- non-empty string literals ----
    // Emptying a string kills tests that assert on the value and survives tests
    // that only assert it is truthy, which is precisely the distinction wanted.
    if (ts.isStringLiteral(node) && node.text.length > 0) {
      // Skip import specifiers: mutating those breaks the module, not the test.
      const parent = node.parent as TS.Node | undefined;
      const isModuleSpecifier =
        parent !== undefined &&
        (ts.isImportDeclaration(parent) ||
          ts.isExportDeclaration(parent) ||
          ts.isModuleDeclaration(parent));
      if (!isModuleSpecifier) {
        push(node.getStart(sourceFile), node.getEnd(), '""', "string-literal");
      }
    }

    // ---- return values ----
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const expression = node.expression;
      const text = source.slice(expression.getStart(sourceFile), expression.getEnd());
      // `return true` is already covered by the boolean operator.
      if (text !== "true" && text !== "false" && text !== "null" && text !== "undefined") {
        push(
          expression.getStart(sourceFile),
          expression.getEnd(),
          "null",
          "return-value",
        );
      }
    }
  });

  return mutants;
}

interface PythonMutantPayload {
  readonly mutants: ReadonlyArray<{
    readonly line: number;
    readonly operator: string;
    readonly start: number;
    readonly end: number;
    readonly replacement: string;
    readonly original: string;
  }>;
}

const PYTHON_OPERATORS = new Set<OperatorName>([
  "conditional-boundary",
  "negate-conditional",
  "arithmetic",
  "logical",
  "boolean-literal",
  "return-value",
  "string-literal",
]);

/** Mutants for one Python file, via `keel_gates.mutate`. */
export function generatePythonMutants(
  file: string,
  source: string,
  options: GenerateOptions,
): Mutant[] {
  const res = exec(pythonBin(), ["-m", "keel_gates.mutate"], {
    cwd: `${options.pluginRoot}/python`,
    input: JSON.stringify({ path: file, source, changed_lines: [...options.changedLines] }),
    timeoutMs: 15_000,
  });

  if (!res.ok || res.value.code !== 0) return [];

  try {
    const payload = JSON.parse(res.value.stdout) as PythonMutantPayload;
    return payload.mutants
      .filter((m) => PYTHON_OPERATORS.has(m.operator as OperatorName))
      .map((m) => ({
        file,
        line: m.line,
        operator: m.operator as OperatorName,
        start: m.start,
        end: m.end,
        replacement: m.replacement,
        original: m.original,
      }));
  } catch {
    return [];
  }
}

/** Mutants for a file in whichever language it is written in. */
export async function generateMutants(
  file: string,
  source: string,
  options: GenerateOptions,
): Promise<Mutant[]> {
  if (options.changedLines.size === 0) return [];
  if (isPythonFile(file)) return generatePythonMutants(file, source, options);
  if (isTypeScriptLike(file)) return generateTypeScriptMutants(file, source, options);
  return [];
}
