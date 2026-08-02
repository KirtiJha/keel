import type { DisplayState, VerifyCheck } from "./state.js";

/**
 * The MessageDisplay formatter.
 *
 * Display-only: `hookSpecificOutput.displayContent` replaces what is on screen
 * while the transcript and the model's own context keep the original. That is
 * what makes aggressive compression safe here — nothing downstream reads this.
 *
 * Two rules govern everything below.
 *
 *  1. Never break the display. Any doubt — unparsed input, a blown budget, a
 *     result that would lose information — returns null and the original text
 *     renders untouched.
 *  2. Always preserve the `decide` line. Compression is the point of the
 *     exercise everywhere else, but surfaced assumptions are the one thing
 *     developers skim past today and regret later. If an assumption is present
 *     in the source and would not survive into the output, we render nothing
 *     rather than a tidy summary that hides it.
 */

export const BULLET = "◆";
const MAX_INPUT_CHARS = 20_000;
const MAX_TITLE_CHARS = 64;
const MAX_FILES_SHOWN = 4;

/** Phrases that mark a decision the developer should see. */
const ASSUMPTION_PATTERNS: readonly RegExp[] = [
  /\b(?:I(?:'ll| will| have)?\s+assum\w+|assuming|assumed)\b/i,
  /\bdefault(?:ing|ed)?\s+to\b/i,
  /\bwent with\b/i,
  /\bunless you(?:'d)?\b/i,
  /\bif that(?:'s| is) wrong\b/i,
  /\bconfirm or\b/i,
  /\blet me know if\b/i,
  /\btell me if\b/i,
  /\bI chose\b/i,
  /\bpicked\b.*\bover\b/i,
];

/** Phrases that introduce a next step. */
const NEXT_PATTERNS: readonly RegExp[] = [
  /^\s*next[,:]?\s+/i,
  /^\s*then\s+/i,
  /^\s*(?:you can|you should|to finish|remaining)\b/i,
  /\brun\s+`?\/(?:verify|code-review|simplify|security-review)/i,
  /\bopen\s+(?:a\s+)?PR\b/i,
];

const FILE_TOKEN = /(?:[\w.@-]+\/)+[\w.@-]+\.[a-z]{1,5}\b/gi;

export interface FormatOptions {
  /** Abort and return null past this. */
  readonly budgetMs: number;
  /** Start time, so the budget covers the caller's work too. */
  readonly startedAt?: bigint;
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** Split into sentences without a full tokenizer. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/** A short label for what this message is about. */
function extractTitle(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = stripMarkdown(raw);
    if (line === "") continue;
    if (line.startsWith(">") || line.startsWith("```")) continue;

    const firstSentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
    const title = firstSentence.replace(/\s+/g, " ").trim();
    if (title.length < 3) continue;
    return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : title;
  }
  return null;
}

/** File paths named in the message, in first-seen order. */
export function extractFiles(text: string): string[] {
  FILE_TOKEN.lastIndex = 0;
  const seen = new Set<string>();
  let match: RegExpExecArray | null = FILE_TOKEN.exec(text);
  while (match !== null) {
    seen.add(match[0]);
    match = FILE_TOKEN.exec(text);
  }
  return [...seen];
}

/** Sentences that state an assumption or ask for confirmation. */
export function extractDecisions(text: string): string[] {
  const out: string[] = [];
  for (const sentence of sentences(text)) {
    // Over-long sentences are not renderable as a compact row.
    if (sentence.length > 220) continue;
    if (ASSUMPTION_PATTERNS.some((re) => re.test(sentence))) {
      out.push(stripMarkdown(sentence));
    }
  }
  return out;
}

/**
 * Does the message state an assumption *anywhere*, renderable or not?
 *
 * Deliberately separate from `extractDecisions`, which skips sentences too long
 * to render. Without this, an assumption written as one long sentence would be
 * dropped silently — the summary would look complete while having hidden the
 * one thing rule 2 exists to protect.
 */
export function hasAssumption(text: string): boolean {
  return ASSUMPTION_PATTERNS.some((re) => re.test(text));
}

function extractNext(text: string): string | null {
  for (const sentence of sentences(text)) {
    if (sentence.length > 160) continue;
    if (NEXT_PATTERNS.some((re) => re.test(sentence))) {
      const cleaned = stripMarkdown(sentence).replace(/^(?:next|then)[,:]?\s+/i, "");
      if (cleaned !== "") return cleaned;
    }
  }
  return null;
}

function renderChecks(checks: readonly VerifyCheck[]): string | null {
  if (checks.length === 0) return null;
  return checks
    .map((c) => `${c.ok ? "✓" : "✗"} ${c.label}${c.detail === undefined ? "" : ` ${c.detail}`}`)
    .join("  ");
}

function renderFiles(files: readonly string[]): string | null {
  if (files.length === 0) return null;
  const shown = files.slice(0, MAX_FILES_SHOWN).join(", ");
  const extra = files.length - MAX_FILES_SHOWN;
  return extra > 0 ? `${shown} +${extra} more` : shown;
}

/**
 * Format one assistant message, or return null to leave it alone.
 */
export function formatMessage(
  text: string,
  state: DisplayState,
  options: FormatOptions,
): string | null {
  const startedAt = options.startedAt ?? process.hrtime.bigint();

  try {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed === "") return null;

    // Long messages are prose the developer wants in full, and scanning them
    // risks the budget for little gain.
    if (trimmed.length > MAX_INPUT_CHARS) return null;

    // Code blocks are the content, not narration about it.
    if (trimmed.startsWith("```")) return null;

    const title = extractTitle(trimmed);
    if (title === null) return null;

    const decisions = extractDecisions(trimmed);
    const files = state.changedFiles.length > 0 ? state.changedFiles : extractFiles(trimmed);
    const checks = renderChecks(state.checks);
    const next = extractNext(trimmed);

    if (elapsedMs(startedAt) > options.budgetMs) return null;

    const rows: Array<readonly [string, string]> = [];
    const fileRow = renderFiles(files);
    if (fileRow !== null) rows.push(["changed", fileRow]);
    if (checks !== null) rows.push(["verified", checks]);
    for (const decision of decisions) rows.push(["decide", decision]);
    if (next !== null) rows.push(["next", next]);

    // A title with nothing under it is not an improvement on the original.
    if (rows.length === 0) return null;

    // Rule 2, enforced structurally: if the source stated an assumption
    // anywhere and it did not make it into a `decide` row, render nothing
    // rather than a tidy summary that has hidden it.
    if (hasAssumption(trimmed) && !rows.some(([label]) => label === "decide")) return null;

    const lines = [`${BULLET} ${title}`];
    for (const [label, value] of rows) {
      lines.push(`  ${label.padEnd(9)} ${value}`);
    }

    if (elapsedMs(startedAt) > options.budgetMs) return null;
    return lines.join("\n");
  } catch {
    // Never break the display.
    return null;
  }
}
