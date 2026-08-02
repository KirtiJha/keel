/**
 * Constraint 0.10: secrets never enter logs, telemetry, or hook output.
 *
 * This is a belt-and-braces layer. The primary defence is that telemetry only
 * ever carries an explicit allowlist of scalar fields (see src/telemetry) — no
 * file contents, no prompts, no diffs. This module scrubs anything that reaches
 * a log line anyway, because a log line is written from many call sites and one
 * of them will eventually carry a token.
 */

const REDACTED = "[redacted]";

/**
 * Ordered, anchored patterns. Each captures a leading context group so the
 * replacement keeps enough shape to debug with ("Authorization: [redacted]")
 * without keeping the value.
 */
const PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly replace: string }> = [
  // Bearer / Basic auth headers and values.
  { re: /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*\S+/gi, replace: `$1${REDACTED}` },
  { re: /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replace: `$1 ${REDACTED}` },

  // Common provider key shapes.
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { re: /\bghp_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // Google keys are AIza + 35, but a redactor should over-match rather than
  // under-match: a near-miss length must not leak the whole key.
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: REDACTED },

  // key=value / "key": "value" for secret-shaped names.
  {
    re: /\b([A-Za-z0-9_-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;)}\]]+)/gi,
    replace: `$1$2${REDACTED}`,
  },

  // PEM blocks collapse entirely.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },

  // JWTs.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },

  // URLs carrying inline credentials.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replace: `$1${REDACTED}@` },
];

/**
 * Key names whose *value* is secret regardless of the value's own shape.
 * In flat text the key=value pattern above covers this; in structured data the
 * value arrives detached from its key, so `redactValue` checks the key itself.
 */
const SECRET_KEY_RE =
  /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|auth)/i;

/** Scrub secret-shaped substrings from a single string. */
export function redact(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    // Each pattern carries /g; reset lastIndex because the regexes are module-level.
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

/** Recursively scrub a JSON-ish value. Keys are scrubbed as well as values. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // A secret-shaped key redacts its whole subtree: the value on its own
      // ("hunter2") looks like ordinary text and would otherwise survive.
      out[redact(k)] = SECRET_KEY_RE.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return undefined;
}
