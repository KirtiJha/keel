import type { Finding, GateContext } from "../../src/standards/types.js";

/**
 * Reference pack 1 (build spec M4.6): a real AST rule, not a regex sweep.
 *
 * Fails on raw colour literals in styling positions. The AST matters here —
 * a plain regex for `#[0-9a-f]{3,8}` flags URL fragments, git SHAs in comments,
 * CSS selectors and test fixtures, and a rule that cries wolf gets switched off
 * within a week.
 *
 * Detected positions:
 *   1. object properties whose name is a colour property   ({ color: "#fff" })
 *   2. JSX `style={{ ... }}` object properties             (same shape)
 *   3. tagged template literals from CSS-in-JS             (styled.div`color: #fff`)
 *
 * Only `import type` is used: pack rules are transpiled per file, so a value
 * import would not resolve at runtime.
 */

const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const FUNCTIONAL = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;

/** CSS declarations inside a template literal: `color: #fff;`. */
const CSS_DECLARATION = /(^|[;{}\n])\s*([a-z-]+)\s*:\s*([^;{}\n]+)/gi;

function asStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === "string");
}

function isRawColour(text: string, allowed: readonly string[]): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (allowed.some((a) => a.toLowerCase() === trimmed.toLowerCase())) return false;
  return HEX.test(trimmed) || FUNCTIONAL.test(trimmed);
}

const rule = (context: GateContext): Finding[] => {
  const parsed = context.ast;
  if (parsed === null) return [];

  const { ts, sourceFile } = parsed;
  const colourProperties = new Set(
    asStringArray(context.config["color_properties"], []).map((p) => p.toLowerCase()),
  );
  const allowed = asStringArray(context.config["allowed_literals"], []);
  const tokenPrefixes = asStringArray(context.config["token_prefixes"], []);

  const findings: Finding[] = [];
  const seen = new Set<number>();

  const report = (line: number, column: number, value: string, where: string): void => {
    if (seen.has(line)) return;
    seen.add(line);
    const suggestion = tokenPrefixes[0] ?? "tokens";
    findings.push({
      line,
      column,
      message: `raw colour ${value.trim()} in ${where}`,
      fix: `use a design token instead, e.g. \`${suggestion}.color.<name>\``,
    });
  };

  /** Property name for an object-literal member, lower-cased. */
  const propertyName = (node: import("typescript").ObjectLiteralElementLike): string | null => {
    const name = node.name;
    if (name === undefined) return null;
    if (ts.isIdentifier(name)) return name.text.toLowerCase();
    if (ts.isStringLiteral(name)) return name.text.toLowerCase();
    return null;
  };

  const visit = (node: import("typescript").Node): void => {
    // 1 & 2 — object literal properties, which covers both plain style objects
    // and JSX style={{ ... }} since the latter is an object literal too.
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      if (name !== null && colourProperties.has(name)) {
        const initializer = node.initializer;
        if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
          if (isRawColour(initializer.text, allowed)) {
            report(
              parsed.lineOf(initializer.getStart(sourceFile)),
              parsed.columnOf(initializer.getStart(sourceFile)),
              initializer.text,
              `\`${name}\``,
            );
          }
        }
      }
    }

    // 3 — CSS-in-JS tagged templates: styled.div`...`, css`...`, createGlobalStyle`...`.
    if (ts.isTaggedTemplateExpression(node)) {
      const template = node.template;
      const chunks: Array<{ text: string; pos: number }> = [];

      if (ts.isNoSubstitutionTemplateLiteral(template)) {
        chunks.push({ text: template.text, pos: template.getStart(sourceFile) });
      } else {
        chunks.push({ text: template.head.text, pos: template.head.getStart(sourceFile) });
        for (const span of template.templateSpans) {
          chunks.push({ text: span.literal.text, pos: span.literal.getStart(sourceFile) });
        }
      }

      for (const chunk of chunks) {
        CSS_DECLARATION.lastIndex = 0;
        let match: RegExpExecArray | null = CSS_DECLARATION.exec(chunk.text);
        while (match !== null) {
          const property = (match[2] ?? "").toLowerCase();
          const value = match[3] ?? "";
          // Template CSS uses kebab-case; the config list is camelCase.
          const camel = property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          if (
            (colourProperties.has(camel) || colourProperties.has(property)) &&
            isRawColour(value, allowed)
          ) {
            // Offset within the chunk maps back to an absolute source position.
            const offset = match.index + match[0].indexOf(value);
            report(
              parsed.lineOf(chunk.pos + offset),
              parsed.columnOf(chunk.pos + offset),
              value,
              `\`${property}\``,
            );
          }
          match = CSS_DECLARATION.exec(chunk.text);
        }
      }
    }

    node.forEachChild(visit);
  };

  visit(sourceFile);
  return findings;
};

export default rule;
