import { LANGUAGES, type Language } from "../shared/config.js";
import { asRecord, asString, asStringArray } from "../shared/validate.js";

/**
 * `standard.yaml` — the whole of a pack's declaration.
 *
 * Hand-validated rather than schema-validated, for the same reason as the
 * runtime config reader: `loadPacks` runs inside three different hooks, and
 * importing zod there would cost ~26 ms per tool call.
 *
 * Unlike the config, there is only *one* path here — the validation below is
 * strict and is what `keel check` reports. The format is eight fields; a schema
 * library would buy nothing a careful reader does not.
 */

export const PACK_MODES = ["gate", "guide", "review"] as const;
export type PackMode = (typeof PACK_MODES)[number];

export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Standard {
  /** Unique across all search dirs; repo-local wins over org-level. */
  readonly name: string;
  /**
   * gate   — a lint/AST rule; runs in the hook, blocks, never enters context
   * guide  — a skill surfaced when the change touches applies_to paths
   * review — a rubric entry for the review chain
   */
  readonly mode: PackMode;
  readonly applies_to: readonly string[];
  readonly languages: readonly Language[];
  readonly owner: string;
  /** high blocks (exit 2), medium warns, low informs. Gates only. */
  readonly severity: Severity;
  readonly description: string;
  /** Passed verbatim to the rule as `context.config`. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface StandardIssue {
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

const FIELD_HELP: Readonly<Record<string, string>> = {
  name: "lower-case kebab-case matching the folder name, e.g. `api-error-shape`",
  mode: "one of `gate` (lint rule), `guide` (skill) or `review` (rubric entry)",
  applies_to: 'a non-empty list of globs, e.g. ["services/**/handlers/*.ts"]',
  languages: "a non-empty list: `typescript`, `python`, or both",
  owner: "the owning team, e.g. `platform-team`",
  severity: "`high` (blocks), `medium` (warns) or `low` (informs)",
  description: 'one sentence stating the rule, e.g. "API errors use the shared envelope."',
};

function issue(path: string, message: string): StandardIssue {
  return { path, message, fix: FIELD_HELP[path] ?? "see the pack format in README.md" };
}

export interface ParsedStandard {
  readonly standard: Standard | null;
  readonly issues: readonly StandardIssue[];
}

/** Validate parsed `standard.yaml` content. Strict: every problem is reported. */
export function parseStandard(raw: unknown): ParsedStandard {
  const issues: StandardIssue[] = [];
  const record = asRecord(raw);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { standard: null, issues: [issue("(root)", "standard.yaml must be a mapping")] };
  }

  // Unknown keys are a typo until proven otherwise: a misspelled `applies_to`
  // yields a pack that silently never fires.
  const known = new Set([
    "name",
    "mode",
    "applies_to",
    "languages",
    "owner",
    "severity",
    "description",
    "config",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push({
        path: key,
        message: `unknown key \`${key}\``,
        fix: `remove it, or correct the spelling — accepted keys are ${[...known].join(", ")}`,
      });
    }
  }

  const name = asString(record["name"], "");
  if (name === "") issues.push(issue("name", "name is required"));
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    issues.push(issue("name", `name "${name}" must be lower-case kebab-case`));
  }

  const mode = asString(record["mode"], "");
  if (!(PACK_MODES as readonly string[]).includes(mode)) {
    issues.push(issue("mode", mode === "" ? "mode is required" : `unknown mode "${mode}"`));
  }

  const appliesTo = asStringArray(record["applies_to"], []);
  if (!Array.isArray(record["applies_to"]) || appliesTo.length === 0) {
    issues.push(issue("applies_to", "a pack that matches nothing can never fire"));
  }

  const rawLanguages = record["languages"];
  const languages = Array.isArray(rawLanguages)
    ? rawLanguages.filter((l): l is Language => (LANGUAGES as readonly unknown[]).includes(l))
    : [];
  if (!Array.isArray(rawLanguages) || languages.length === 0) {
    issues.push(issue("languages", "declare at least one supported language"));
  } else if (languages.length !== rawLanguages.length) {
    const unknownLanguages = rawLanguages.filter((l) => !(LANGUAGES as readonly unknown[]).includes(l));
    issues.push(issue("languages", `unsupported language(s): ${unknownLanguages.join(", ")}`));
  }

  const owner = asString(record["owner"], "");
  if (owner === "") {
    issues.push(issue("owner", "an unowned rule is an undeletable rule"));
  }

  const severityRaw = record["severity"];
  const severity = severityRaw === undefined ? "medium" : asString(severityRaw, "");
  if (!(SEVERITIES as readonly string[]).includes(severity)) {
    issues.push(issue("severity", `unknown severity "${String(severityRaw)}"`));
  }

  const description = asString(record["description"], "");
  if (description === "") issues.push(issue("description", "description is required"));

  if (issues.length > 0) return { standard: null, issues };

  return {
    standard: {
      name,
      mode: mode as PackMode,
      applies_to: appliesTo,
      languages,
      owner,
      severity: severity as Severity,
      description,
      config: asRecord(record["config"]),
    },
    issues: [],
  };
}
