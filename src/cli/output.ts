import { redact } from "../shared/redact.js";

/**
 * Terminal output helpers. Colour only when the stream is a TTY.
 *
 * Every write goes through `out`/`errOut`, and both redact. The CLI prints
 * repository content — a gate finding quoting the offending line, a config
 * value, a spec delta — and `keel gate --json` output is exactly the sort of
 * thing a CI job pipes into a log or a PR comment. The hook path already
 * redacts at its single choke point; this is the same guarantee for the other
 * half of the product, enforced in one place so no command has to remember.
 */

function out(text: string): void {
  process.stdout.write(redact(text));
}

function errOut(text: string): void {
  process.stderr.write(redact(text));
}

const useColour = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const wrap = (code: string) => (text: string): string =>
  useColour ? `[${code}m${text}[0m` : text;

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");

export const SYMBOLS = {
  ok: "✓",
  fail: "✗",
  warn: "!",
  info: "·",
} as const;

export function heading(text: string): void {
  out(`\n${bold(text)}\n`);
}

export function line(text = ""): void {
  out(`${text}\n`);
}

export function ok(text: string): void {
  line(`  ${green(SYMBOLS.ok)} ${text}`);
}

export function fail(text: string): void {
  line(`  ${red(SYMBOLS.fail)} ${text}`);
}

export function warn(text: string): void {
  line(`  ${yellow(SYMBOLS.warn)} ${text}`);
}

export function info(text: string): void {
  line(`  ${dim(SYMBOLS.info)} ${text}`);
}

export function detail(text: string): void {
  line(`    ${dim(text)}`);
}

/**
 * A usage or precondition error: the command did not run at all.
 *
 * Goes to **stderr**, unlike `fail`, which reports a finding the command was
 * asked to look for and belongs in the report on stdout. The split matters in
 * CI: `keel route --against origin/main` on an unfetched ref used to exit 0
 * with an empty stderr, so a wrapper script had nothing to detect.
 */
export function fatal(text: string): void {
  errOut(`  ${red(SYMBOLS.fail)} ${text}\n`);
}

/** The fix line under a `fatal`. Same stream, same indent as `detail`. */
export function fatalDetail(text: string): void {
  errOut(`    ${dim(text)}\n`);
}

/** One JSON document on stdout, for `--json`. */
export function json(value: unknown): void {
  out(`${JSON.stringify(value)}\n`);
}

/** Render key/value rows with aligned keys. */
export function rows(entries: ReadonlyArray<readonly [string, string]>): void {
  const width = entries.reduce((max, [k]) => Math.max(max, k.length), 0);
  for (const [key, value] of entries) {
    line(`  ${dim(key.padEnd(width))}  ${value}`);
  }
}
