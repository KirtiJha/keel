/**
 * Constraint 0.10: secrets never enter logs, telemetry, or hook output.
 *
 * This is a belt-and-braces layer. The primary defence is that telemetry only
 * ever carries an explicit allowlist of scalar fields (see src/telemetry) — no
 * file contents, no prompts, no diffs. This module scrubs anything that reaches
 * a log line anyway, because a log line is written from many call sites and one
 * of them will eventually carry a token.
 *
 * Two properties this module has to keep, because it runs on hook output paths:
 * every pattern is linear in the input length (no nested or adjacent unbounded
 * quantifiers), and a false positive that mangles ordinary output — a hex
 * colour, a git SHA, `PATH=`, `author=` — is treated as a real defect, not as
 * harmless caution.
 */

const REDACTED = "[redacted]";

/** `[redacted]` as regex source, so a pattern can refuse to re-redact a marker
 *  it already wrote (otherwise `Authorization: [redacted]` gets a second pass
 *  and comes out as `Authorization: [redacted]]`). */
const REDACTED_SRC = REDACTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/*
 * ---------------------------------------------------------------------------
 * The one list of secret-shaped key names.
 *
 * Both redaction paths are derived from the SECRET_KEY_SRC built below: the
 * flat-text `KEY=value` pattern in PATTERNS, and the structured-key test that
 * `redactValue` applies to object keys. These used to be two hand-maintained
 * lists and they drifted — `{AUTH: "..."}` was redacted while the flat text
 * `AUTH=...` was not, because only one of the lists carried `auth`. Sharing a
 * single source is what makes that whole class of bug impossible, so keep it
 * shared: a new key name goes here, never into one of the two consumers.
 * ---------------------------------------------------------------------------
 */

/**
 * Distinctive words. Matched anywhere inside a key name (`AWS_SECRET_ACCESS_KEY`,
 * `userPassword`), because ordinary identifiers do not contain them by accident.
 * No prefix is spelled out before them: the match starts at the word, and the
 * text before it is left alone, which yields the same output
 * (`AWS_SECRET_ACCESS_KEY=[redacted]`) while letting the engine skip ahead on
 * the word's first letter instead of testing every position in the input.
 */
const SECRET_KEY_WORDS: readonly string[] = [
  "secret",
  "token",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "privkey",
  "api[_-]?key",
  "access[_-]?key",
  "private[_-]?key",
  "signing[_-]?key",
  "encryption[_-]?key",
  "session[_-]?cookie",
  "db[_-]?pass",
];

/**
 * Ambiguous words. Matched only as a whole `_`/`-` delimited segment of a key
 * (`AUTH`, `GITHUB_PAT`, `X-AUTH-KEY`) — as free substrings they would eat
 * `PATH`, `PATTERN`, `AUTHOR` and `compat`, which is exactly the over-redaction
 * this module must not do. The surrounding lookaround is what enforces that;
 * longest spelling first, so `AUTHORIZATION` is not split at `AUTH`.
 */
const SECRET_KEY_ATOMS: readonly string[] = ["authorization", "auth", "pat"];

/**
 * The rest of a key name after the matched word. Length-bounded on purpose:
 * real key names are short, and an unbounded run makes the pattern quadratic on
 * adversarial input.
 */
const KEY_AFFIX = "[A-Za-z0-9_-]{0,64}";

const SECRET_KEY_SRC =
  `(?:(?:${SECRET_KEY_WORDS.join("|")})${KEY_AFFIX}` +
  `|(?<![A-Za-z0-9])(?:${SECRET_KEY_ATOMS.join("|")})(?:[_-]${KEY_AFFIX})?(?![A-Za-z0-9]))`;

/**
 * Ordered, anchored patterns. Each captures a leading context group so the
 * replacement keeps enough shape to debug with ("Authorization: [redacted]")
 * without keeping the value.
 */
const PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly replace: string }> = [
  // Bearer / Basic auth headers and values. The scheme word is folded into one
  // optional group so there are never two adjacent `\s*` runs — that shape is
  // quadratic on "Authorization:" followed by a long whitespace run.
  {
    re: /\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?\S+/gi,
    replace: `$1${REDACTED}`,
  },
  { re: /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replace: `$1 ${REDACTED}` },

  // Common provider key shapes.
  // Hyphen and underscore forms both occur: sk-ant-…, sk-proj-… alongside
  // Stripe's sk_live_… .
  { re: /\bsk[-_][A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  // Stripe secret and restricted keys (rk_live_… is not covered by sk above).
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: REDACTED },
  { re: /\bnpm_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  // The whole GitHub token family: classic (p), oauth (o), user-to-server (u),
  // server-to-server (s), refresh (r).
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  // Slack: bot/user/app/refresh/… — `e` is the refresh-token prefix.
  { re: /\bxox[abeprs][-.][A-Za-z0-9-]{10,}/g, replace: REDACTED },
  // AKIA is a long-lived access key, ASIA a temporary session key.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  // Google keys are AIza + 35, but a redactor should over-match rather than
  // under-match: a near-miss length must not leak the whole key.
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: REDACTED },

  // key=value / "key": "value" for secret-shaped names. The quote/whitespace
  // run is written as `\s*(?:["']\s*)?` rather than `\s*["']?\s*`: the two
  // forms accept the same text, but the latter has two adjacent unbounded
  // whitespace runs and goes quadratic on `TOKEN` + a long whitespace run.
  // The negative lookahead stops the pattern re-redacting its own output: with
  // `authorization` on the key list, `Authorization: [redacted]` would
  // otherwise come back round as `Authorization: [redacted]]`.
  {
    re: new RegExp(
      `(${SECRET_KEY_SRC})(\\s*(?:["']\\s*)?[:=]\\s*["']?)(?!${REDACTED_SRC})([^\\s"',;)}\\]]+)`,
      "gi",
    ),
    replace: `$1$2${REDACTED}`,
  },

  // JWTs.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },

  // URLs carrying inline credentials. The scheme is length-bounded ("git+ssh",
  // "postgres" — nothing is near 32): unbounded, a 1 MB run of letters with no
  // "://" in it backtracks quadratically.
  { re: /\b([a-z][a-z0-9+.-]{0,32}:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replace: `$1${REDACTED}@` },
];

/**
 * Key names whose *value* is secret regardless of the value's own shape.
 * In flat text the key=value pattern above covers this; in structured data the
 * value arrives detached from its key, so `redactValue` checks the key itself.
 *
 * Literally the same source as the flat-text pattern above (see
 * SECRET_KEY_WORDS): the key half of that pattern, with no assignment or value
 * after it, because a structured key stands on its own.
 */
const SECRET_KEY_RE = new RegExp(SECRET_KEY_SRC, "i");

interface Span {
  readonly start: number;
  readonly end: number;
}

// Header words are bounded (`RSA `, `OPENSSH `, `ENCRYPTED `) so a long run of
// capitals cannot make the marker itself backtrack.
const PEM_BEGIN_RE = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g;
const PEM_END_RE = /-----END [A-Z ]{0,40}PRIVATE KEY-----/g;

function findAll(re: RegExp, input: string): Span[] {
  const spans: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/**
 * Collapse PEM private-key blocks.
 *
 * Deliberately two linear scans plus a merge, not the obvious single
 * `BEGIN[\s\S]*?END` regex. That regex is quadratic: every BEGIN marker rescans
 * the whole remaining input looking for an END, so input consisting of repeated
 * BEGIN markers costs O(n²) — measured at 9 ms for 64 KB but 2.1 s for 1 MB.
 * Here each marker is found once and blocks are paired in order, which is
 * linear in the input length.
 */
function redactPemBlocks(input: string): string {
  if (!input.includes("-----BEGIN ")) return input;
  const begins = findAll(PEM_BEGIN_RE, input);
  if (begins.length === 0) return input;
  const ends = findAll(PEM_END_RE, input);
  if (ends.length === 0) return input;

  let out = "";
  let cursor = 0;
  let ei = 0;
  for (const begin of begins) {
    // A BEGIN inside a block already collapsed is part of that block.
    if (begin.start < cursor) continue;
    while (ei < ends.length) {
      const candidate = ends[ei];
      if (candidate !== undefined && candidate.start >= begin.end) break;
      ei++;
    }
    const end = ends[ei];
    // Unterminated block: no END follows, so there is nothing to bound. Leave
    // the text as it is, exactly as the non-greedy regex did.
    if (end === undefined) break;
    out += input.slice(cursor, begin.start) + REDACTED;
    cursor = end.end;
    ei++;
  }
  return out + input.slice(cursor);
}

/** Scrub secret-shaped substrings from a single string. */
export function redact(input: string): string {
  // PEM first: a key block collapses whole, so no later pattern can chew a hole
  // in the middle of one and leave the rest of the key behind.
  let out = redactPemBlocks(input);
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
