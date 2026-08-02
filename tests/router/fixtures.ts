import type { Track } from "../../src/shared/config.js";

/**
 * Router fixture suite (build spec M3 acceptance: >= 30 diffs, each with an
 * asserted expected track).
 *
 * These run against a real temporary git repository — real commits, real
 * `git diff`, real AST parsing, real `git grep` caller counts — rather than
 * hand-built `ChangeSignals`. A synthetic-signal test would pass even if the
 * signal collection were wrong, which is the half most likely to break.
 */

/** Files committed as the baseline every fixture starts from. */
export const BASE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({ name: "fixture-repo", version: "1.0.0" }, null, 2),

  "src/util.ts": [
    "export function slugify(input: string): string {",
    "  return input.toLowerCase().replace(/\\s+/g, '-');",
    "}",
    "",
    "export function truncate(input: string, max: number): string {",
    "  return input.length > max ? `${input.slice(0, max)}...` : input;",
    "}",
  ].join("\n"),

  "src/logger.ts": [
    "export function logLine(message: string): void {",
    "  process.stdout.write(`${message}\\n`);",
    "}",
  ].join("\n"),

  "src/auth/refresh.ts": [
    "export function refreshToken(token: string): string {",
    "  return `${token}-refreshed`;",
    "}",
  ].join("\n"),

  "src/auth/session.ts": [
    "export const SESSION_TTL_MINUTES = 15;",
  ].join("\n"),

  "db/migrations/0001_init.sql": "CREATE TABLE accounts (id TEXT PRIMARY KEY);",

  "openapi/payments.yaml": ["openapi: 3.0.0", "info:", "  title: payments", "  version: '1'"].join("\n"),

  // `toCents` is referenced from many files so caller counting clears the
  // default threshold of 5 and exercises rule 2 for real.
  "packages/core/src/money.ts": [
    "export function toCents(amount: number): number {",
    "  return Math.round(amount * 100);",
    "}",
    "",
    "export function fromCents(cents: number): number {",
    "  return cents / 100;",
    "}",
  ].join("\n"),

  "packages/api/src/charge.ts": "import { toCents } from '../../core/src/money.js';\nexport const charge = (n: number) => toCents(n);",
  "packages/api/src/refund.ts": "import { toCents } from '../../core/src/money.js';\nexport const refund = (n: number) => toCents(n);",
  "packages/api/src/invoice.ts": "import { toCents } from '../../core/src/money.js';\nexport const invoice = (n: number) => toCents(n);",
  "packages/api/src/report.ts": "import { toCents } from '../../core/src/money.js';\nexport const report = (n: number) => toCents(n);",
  "packages/api/src/ledger.ts": "import { toCents } from '../../core/src/money.js';\nexport const ledger = (n: number) => toCents(n);",
  "packages/api/src/payout.ts": "import { toCents } from '../../core/src/money.js';\nexport const payout = (n: number) => toCents(n);",
  "packages/api/src/tax.ts": "import { toCents } from '../../core/src/money.js';\nexport const tax = (n: number) => toCents(n);",

  // A symbol used within one package only — rule 2 escalates to standard, not full.
  "packages/core/src/format.ts": [
    "export function pad(value: string, width: number): string {",
    "  return value.padStart(width, '0');",
    "}",
  ].join("\n"),
  "packages/core/src/a1.ts": "import { pad } from './format.js';\nexport const a1 = () => pad('1', 2);",
  "packages/core/src/a2.ts": "import { pad } from './format.js';\nexport const a2 = () => pad('2', 2);",
  "packages/core/src/a3.ts": "import { pad } from './format.js';\nexport const a3 = () => pad('3', 2);",
  "packages/core/src/a4.ts": "import { pad } from './format.js';\nexport const a4 = () => pad('4', 2);",
  "packages/core/src/a5.ts": "import { pad } from './format.js';\nexport const a5 = () => pad('5', 2);",
  "packages/core/src/a6.ts": "import { pad } from './format.js';\nexport const a6 = () => pad('6', 2);",

  "app/models.py": [
    "def build_account(name: str) -> dict[str, str]:",
    "    return {'name': name}",
    "",
    "",
    "def _internal(value: int) -> int:",
    "    return value + 1",
  ].join("\n"),

  "app/service.py": [
    "def charge_customer(amount: int) -> int:",
    "    return amount",
  ].join("\n"),

  "docs/architecture.md": "# Architecture\n\nOne paragraph.",
  "README.md": "# Fixture repo\n",
};

export interface RouterFixture {
  readonly name: string;
  /** Files to write before routing. `null` deletes the file. */
  readonly change: Readonly<Record<string, string | null>>;
  readonly expected: Track;
  /** Why this case exists; surfaced on failure. */
  readonly because: string;
}

const LONG_BODY = Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`).join("\n");

export const ROUTER_FIXTURES: readonly RouterFixture[] = [
  // ---- Rule 1: forced paths ------------------------------------------------
  {
    name: "migration edit",
    change: { "db/migrations/0001_init.sql": "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT);" },
    expected: "full",
    because: "**/migrations/** is a force_full glob",
  },
  {
    name: "new migration file",
    change: { "db/migrations/0002_add_email.sql": "ALTER TABLE accounts ADD COLUMN email TEXT;" },
    expected: "full",
    because: "a new migration is still a migration",
  },
  {
    name: "auth module edit",
    change: { "src/auth/refresh.ts": "export function refreshToken(token: string): string {\n  return `${token}-v2`;\n}" },
    expected: "full",
    because: "**/auth/** is a force_full glob",
  },
  {
    name: "one-line auth constant change",
    change: { "src/auth/session.ts": "export const SESSION_TTL_MINUTES = 30;" },
    expected: "full",
    because: "forced paths beat the small-change rule entirely",
  },
  {
    name: "openapi spec edit",
    change: { "openapi/payments.yaml": "openapi: 3.0.0\ninfo:\n  title: payments\n  version: '2'" },
    expected: "full",
    because: "openapi/** is a force_full glob",
  },
  {
    name: "auth-adjacent file that does not match the glob",
    change: { "src/logger.ts": "export function logLine(message: string): void {\n  process.stderr.write(`${message}\\n`);\n}" },
    expected: "quick",
    because: "src/authenticate-style names must not trip **/auth/**",
  },

  // ---- Rule 2: widely-called exported symbols ------------------------------
  {
    name: "hot cross-package symbol signature change",
    change: {
      "packages/core/src/money.ts": [
        "export function toCents(amount: number, currency: string): number {",
        "  return Math.round(amount * 100) + currency.length * 0;",
        "}",
        "",
        "export function fromCents(cents: number): number {",
        "  return cents / 100;",
        "}",
      ].join("\n"),
    },
    expected: "full",
    because: "7 callers, all in a different package, crosses a boundary",
  },
  {
    name: "hot within-package symbol signature change",
    change: {
      "packages/core/src/format.ts": [
        "export function pad(value: string, width: number, fill: string): string {",
        "  return value.padStart(width, fill);",
        "}",
      ].join("\n"),
    },
    expected: "standard",
    because: "6 callers but all inside packages/core, so no boundary crossing",
  },
  {
    name: "hot symbol body-only change",
    change: {
      "packages/core/src/money.ts": [
        "export function toCents(amount: number): number {",
        "  return Math.trunc(amount * 100);",
        "}",
        "",
        "export function fromCents(cents: number): number {",
        "  return cents / 100;",
        "}",
      ].join("\n"),
    },
    expected: "quick",
    because: "the signature is unchanged, so rule 2 never sees a changed symbol",
  },

  // ---- Rule 3: quick -------------------------------------------------------
  {
    name: "single-file body tweak",
    change: {
      "src/util.ts": [
        "export function slugify(input: string): string {",
        "  return input.trim().toLowerCase().replace(/\\s+/g, '-');",
        "}",
        "",
        "export function truncate(input: string, max: number): string {",
        "  return input.length > max ? `${input.slice(0, max)}...` : input;",
        "}",
      ].join("\n"),
    },
    expected: "quick",
    because: "one file, few lines, no exported signature change",
  },
  {
    name: "markdown-only edit",
    change: { "README.md": "# Fixture repo\n\nNow with a sentence.\n" },
    expected: "quick",
    because: "docs are not analysed for symbols and stay small",
  },
  {
    name: "comment-only change",
    change: {
      "src/logger.ts": [
        "// Writes one line to stdout.",
        "export function logLine(message: string): void {",
        "  process.stdout.write(`${message}\\n`);",
        "}",
      ].join("\n"),
    },
    expected: "quick",
    because: "adding a comment changes no signature",
  },
  {
    name: "private helper added",
    change: {
      "src/logger.ts": [
        "function prefix(m: string): string { return `[app] ${m}`; }",
        "export function logLine(message: string): void {",
        "  process.stdout.write(`${prefix(message)}\\n`);",
        "}",
      ].join("\n"),
    },
    expected: "quick",
    because: "a non-exported symbol is not an interface change",
  },
  {
    name: "python body-only change",
    change: {
      "app/service.py": ["def charge_customer(amount: int) -> int:", "    return max(amount, 0)"].join("\n"),
    },
    expected: "quick",
    because: "Python signature unchanged",
  },
  {
    name: "python private helper change",
    change: {
      "app/models.py": [
        "def build_account(name: str) -> dict[str, str]:",
        "    return {'name': name}",
        "",
        "",
        "def _internal(value: int, step: int) -> int:",
        "    return value + step",
      ].join("\n"),
    },
    expected: "quick",
    because: "leading underscore means private, so no exported change",
  },

  // ---- Rule 3 boundaries ---------------------------------------------------
  {
    name: "two files changed",
    change: {
      "src/util.ts": "export function slugify(input: string): string {\n  return input.toLowerCase();\n}\n\nexport function truncate(input: string, max: number): string {\n  return input.slice(0, max);\n}",
      "src/logger.ts": "export function logLine(message: string): void {\n  process.stdout.write(message);\n}",
    },
    expected: "standard",
    because: "quick_max_files is 1",
  },
  {
    name: "single file over the line budget",
    change: { "src/logger.ts": `export function logLine(message: string): void {\n${LONG_BODY}\n  process.stdout.write(\`\${message}\\n\`);\n}` },
    expected: "standard",
    because: "more than quick_max_lines changed lines",
  },
  {
    name: "new exported symbol in an existing file",
    change: {
      "src/util.ts": [
        "export function slugify(input: string): string {",
        "  return input.toLowerCase().replace(/\\s+/g, '-');",
        "}",
        "",
        "export function truncate(input: string, max: number): string {",
        "  return input.length > max ? `${input.slice(0, max)}...` : input;",
        "}",
        "",
        "export function titleCase(input: string): string {",
        "  return input.replace(/\\b\\w/g, (c) => c.toUpperCase());",
        "}",
      ].join("\n"),
    },
    expected: "standard",
    because: "an added export is an interface change",
  },
  {
    name: "exported symbol removed",
    change: {
      "src/util.ts": "export function slugify(input: string): string {\n  return input.toLowerCase().replace(/\\s+/g, '-');\n}",
    },
    expected: "standard",
    because: "a removed export is an interface change",
  },
  {
    name: "exported signature widened",
    change: {
      "src/util.ts": [
        "export function slugify(input: string, sep: string): string {",
        "  return input.toLowerCase().replace(/\\s+/g, sep);",
        "}",
        "",
        "export function truncate(input: string, max: number): string {",
        "  return input.length > max ? `${input.slice(0, max)}...` : input;",
        "}",
      ].join("\n"),
    },
    expected: "standard",
    because: "a changed parameter list is an interface change",
  },
  {
    name: "return type changed",
    change: {
      "src/logger.ts": "export function logLine(message: string): boolean {\n  process.stdout.write(`${message}\\n`);\n  return true;\n}",
    },
    expected: "standard",
    because: "the return type is part of the signature",
  },
  {
    name: "python exported signature change",
    change: {
      "app/service.py": ["def charge_customer(amount: int, currency: str) -> int:", "    return amount"].join("\n"),
    },
    expected: "standard",
    because: "Python exported signature changed",
  },
  {
    name: "python new exported function",
    change: {
      "app/service.py": [
        "def charge_customer(amount: int) -> int:",
        "    return amount",
        "",
        "",
        "def refund_customer(amount: int) -> int:",
        "    return -amount",
      ].join("\n"),
    },
    expected: "standard",
    because: "an added public function is an interface change",
  },
  {
    name: "new untracked source file",
    change: { "src/currency.ts": "export function symbolFor(code: string): string {\n  return code === 'USD' ? '$' : code;\n}" },
    expected: "standard",
    because: "a brand-new exported symbol is an interface change",
  },
  {
    name: "file deleted",
    change: { "src/logger.ts": null },
    expected: "standard",
    because: "deleting a module removes its exports",
  },

  // ---- Combinations --------------------------------------------------------
  {
    name: "migration plus source change",
    change: {
      "db/migrations/0003_x.sql": "ALTER TABLE accounts ADD COLUMN tier TEXT;",
      "src/util.ts": "export function slugify(input: string): string {\n  return input.toLowerCase();\n}\n\nexport function truncate(input: string, max: number): string {\n  return input.slice(0, max);\n}",
    },
    expected: "full",
    because: "rule 1 wins over everything below it",
  },
  {
    name: "auth plus hot symbol",
    change: {
      "src/auth/session.ts": "export const SESSION_TTL_MINUTES = 45;",
      "packages/core/src/money.ts": "export function toCents(amount: number, mode: string): number {\n  return Math.round(amount * 100) + mode.length * 0;\n}\n\nexport function fromCents(cents: number): number {\n  return cents / 100;\n}",
    },
    expected: "full",
    because: "two independent full-track reasons",
  },
  {
    name: "many small files",
    change: {
      "src/util.ts": "export function slugify(i: string): string {\n  return i.toLowerCase().replace(/\\s+/g, '-');\n}\n\nexport function truncate(input: string, max: number): string {\n  return input.length > max ? `${input.slice(0, max)}...` : input;\n}",
      "docs/architecture.md": "# Architecture\n\nTwo paragraphs.\n\nSecond.",
      "README.md": "# Fixture repo\n\nEdited.\n",
    },
    expected: "standard",
    because: "over the file budget, nothing forcing full",
  },
  {
    name: "docs plus code",
    change: {
      "docs/architecture.md": "# Architecture\n\nChanged.",
      "src/logger.ts": "export function logLine(message: string): void {\n  process.stdout.write(`${message}!\\n`);\n}",
    },
    expected: "standard",
    because: "two files, so quick is off the table",
  },
  {
    name: "package.json dependency bump",
    change: { "package.json": JSON.stringify({ name: "fixture-repo", version: "1.0.1" }, null, 2) },
    expected: "quick",
    because: "a lockstep version bump is a one-file, small, non-API change",
  },
  {
    name: "large docs-only rewrite",
    change: { "docs/architecture.md": `# Architecture\n\n${Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join("\n\n")}` },
    expected: "standard",
    because: "size alone escalates even without code",
  },
  {
    name: "test file added alongside nothing else",
    change: { "src/util.test.ts": "import { slugify } from './util.js';\nexport const t = () => slugify('a b');" },
    expected: "standard",
    because: "a new file exporting a symbol is an interface change",
  },
  {
    name: "whitespace-only reformat",
    change: {
      "src/logger.ts": "export function logLine(message: string): void {\n\n  process.stdout.write(`${message}\\n`);\n\n}",
    },
    expected: "quick",
    because: "normalised signatures make reformatting invisible to the router",
  },
  {
    name: "no change at all",
    change: {},
    expected: "quick",
    because: "an empty diff is quick by definition",
  },
];
