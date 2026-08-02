import type { Finding, GateContext } from "../../src/standards/types.js";

/**
 * Reference pack 2 (build spec M4.6): one standard, two languages. This is the
 * TypeScript half; `rule.py` is the Python half and they share `standard.yaml`,
 * so the envelope's shape is configured once.
 *
 * Flags error payloads built as ad-hoc object literals instead of through the
 * shared envelope factory. Accepts a call to the factory, because that is the
 * whole point of having one.
 */

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

const rule = (context: GateContext): Finding[] => {
  const parsed = context.ast;
  if (parsed === null) return [];

  const { ts, sourceFile } = parsed;
  const factory = asString(context.config["envelope_factory"], "errorResponse");
  const envelopeType = asString(context.config["envelope_type"], "ErrorResponse");
  const errorKeys = new Set(asStringArray(context.config["error_keys"]).map((k) => k.toLowerCase()));
  const senders = new Set(asStringArray(context.config["response_senders"]));

  const findings: Finding[] = [];
  const seen = new Set<number>();

  const report = (node: import("typescript").Node, what: string): void => {
    const line = parsed.lineOf(node.getStart(sourceFile));
    if (seen.has(line)) return;
    seen.add(line);
    findings.push({
      line,
      column: parsed.columnOf(node.getStart(sourceFile)),
      message: `${what} builds an error payload as a bare object literal`,
      fix: `return \`${factory}(...)\` so the response matches the shared \`${envelopeType}\` envelope`,
    });
  };

  /** Does this object literal look like an error payload? */
  const isErrorPayload = (node: import("typescript").ObjectLiteralExpression): boolean => {
    for (const prop of node.properties) {
      const name = prop.name;
      if (name === undefined) continue;
      const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text.toLowerCase() : null;
      if (text !== null && errorKeys.has(text)) return true;
    }
    return false;
  };

  /**
   * An object built by spreading the factory's result is still enveloped:
   * `{ ...errorResponse(e), traceId }` is a deliberate extension, not a bypass.
   */
  const spreadsFactory = (node: import("typescript").ObjectLiteralExpression): boolean =>
    node.properties.some(
      (prop) =>
        ts.isSpreadAssignment(prop) &&
        ts.isCallExpression(prop.expression) &&
        prop.expression.expression.getText(sourceFile).includes(factory),
    );

  const check = (node: import("typescript").Node, what: string): void => {
    if (!ts.isObjectLiteralExpression(node)) return;
    if (!isErrorPayload(node)) return;
    if (spreadsFactory(node)) return;
    report(node, what);
  };

  const visit = (node: import("typescript").Node): void => {
    // `return { error: "..." }`
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      check(node.expression, "return statement");
    }

    // `res.json({ error })`, `res.status(500).send({ error })`, `JSONResponse({...})`
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      if (senders.has(name)) {
        const first = node.arguments[0];
        if (first !== undefined) check(first, `\`${name}()\``);
      }
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return findings;
};

export default rule;
