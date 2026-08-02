import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  DEFAULT_ENABLED_SKILLS,
  DEFAULT_EXEMPT_GLOBS,
  DEFAULT_PACKAGE_ROOTS,
  DEFAULT_PACKS_REF,
  DEFAULT_PACK_DIRS,
  DEFAULT_TELEMETRY_PATH,
  DEFAULT_TEST_GLOBS,
  EFFORTS,
  LANGUAGES,
  TELEMETRY_SINKS,
  type KeelConfig,
} from "./config.js";
import { configPath, isFile } from "./paths.js";
import { errorMessage, type Result, err, ok } from "./result.js";

/**
 * The strict Zod schema — the "fail loud at `keel init`" half of constraint 0.9.
 *
 * Loaded only by `keel check`, `keel init`, and (lazily) `SessionStart`. Hooks
 * use the coercing reader in `config.ts` instead, because importing zod costs
 * ~26 ms per tool call.
 *
 * Defaults here mirror the exported constants in `config.ts`, so there is one
 * set of values with two consumers rather than two sets that must agree.
 */

const GlobList = z.array(z.string().min(1, "glob must not be empty"));

export const EffortSchema = z.enum(EFFORTS);
export const LanguageSchema = z.enum(LANGUAGES);
export const TrackSchema = z.enum(["quick", "standard", "full"]);

export const KeelConfigSchema = z
  .object({
    version: z.literal(1),

    repo: z.object({
      name: z.string().min(1, "repo.name must not be empty"),
      languages: z.array(LanguageSchema).min(1, "declare at least one language"),
    }),

    tracks: z
      .object({
        quick: z.object({ effort: EffortSchema.default("low") }).default({ effort: "low" }),
        standard: z.object({ effort: EffortSchema.default("medium") }).default({ effort: "medium" }),
        full: z.object({ effort: EffortSchema.default("high") }).default({ effort: "high" }),
      })
      .default({ quick: { effort: "low" }, standard: { effort: "medium" }, full: { effort: "high" } }),

    router: z
      .object({
        force_full_globs: GlobList.default([]),
        quick_max_files: z.number().int().min(1).default(1),
        quick_max_lines: z.number().int().min(1).default(50),
        escalate_caller_threshold: z.number().int().min(0).default(5),
        package_roots: GlobList.default([...DEFAULT_PACKAGE_ROOTS]),
      })
      .default({
        force_full_globs: [],
        quick_max_files: 1,
        quick_max_lines: 50,
        escalate_caller_threshold: 5,
        package_roots: [...DEFAULT_PACKAGE_ROOTS],
      }),

    standards: z
      .object({
        packs_ref: z.string().min(1).default(DEFAULT_PACKS_REF),
        disabled: z.array(z.string().min(1)).default([]),
        dirs: z.array(z.string().min(1)).default([...DEFAULT_PACK_DIRS]),
      })
      .default({ packs_ref: DEFAULT_PACKS_REF, disabled: [], dirs: [...DEFAULT_PACK_DIRS] }),

    tdd: z
      .object({
        enabled: z.boolean().default(true),
        outer_loop: z.boolean().default(false),
        exempt_globs: GlobList.default([...DEFAULT_EXEMPT_GLOBS]),
        test_globs: GlobList.default([...DEFAULT_TEST_GLOBS]),
      })
      .default({
        enabled: true,
        outer_loop: false,
        exempt_globs: [...DEFAULT_EXEMPT_GLOBS],
        test_globs: [...DEFAULT_TEST_GLOBS],
      }),

    telemetry: z
      .object({
        sink: z.enum(TELEMETRY_SINKS).default("file"),
        path: z.string().min(1).default(DEFAULT_TELEMETRY_PATH),
      })
      .default({ sink: "file", path: DEFAULT_TELEMETRY_PATH }),

    upstream: z
      .object({
        enabled_skills: z.array(z.string().min(1)).default([...DEFAULT_ENABLED_SKILLS]),
        disabled_skills: z.array(z.string().min(1)).default([]),
      })
      .default({ enabled_skills: [...DEFAULT_ENABLED_SKILLS], disabled_skills: [] }),

    display: z
      .object({
        enabled: z.boolean().default(true),
        budget_ms: z.number().int().min(10).max(5000).default(100),
      })
      .default({ enabled: true, budget_ms: 100 }),
  })
  .strict();

/**
 * Compile-time proof that the schema's output is a valid `KeelConfig`.
 *
 * One direction only: `KeelConfig` declares its arrays `readonly`, which a
 * mutable schema output satisfies but not the reverse. This catches the drift
 * that matters — a schema field renamed, removed, or retyped away from the
 * interface every other module programs against.
 */
type SchemaOutput = z.infer<typeof KeelConfigSchema>;
type AssertAssignable<_A extends B, B> = true;
export type _SchemaMatchesInterface = AssertAssignable<SchemaOutput, KeelConfig>;

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

/** Actionable hints keyed by dotted config path (M1 acceptance). */
const FIELD_HELP: Readonly<Record<string, string>> = {
  version: "set `version: 1` — it is the config format version, not your release version",
  "repo.name": "set `repo.name` to the repository name, e.g. `name: payments-api`",
  "repo.languages": "list the languages in this repo, e.g. `languages: [typescript, python]`",
  "router.quick_max_files": "a positive integer — the file count above which quick is not offered",
  "router.quick_max_lines": "a positive integer — the changed-line count above which quick is not offered",
  "router.escalate_caller_threshold":
    "a non-negative integer — external callers above this escalate off quick",
  "router.force_full_globs": 'a list of globs, e.g. `- "**/migrations/**"`',
  "standards.packs_ref": "a pinned pack reference, e.g. `keel-standards@1.0.0` — never `latest`",
  "standards.dirs": "a list of directories to search for packs, e.g. `[standards]`",
  "tdd.exempt_globs": "a list of globs exempt from all four TDD gates",
  "tdd.test_globs": "a list of globs identifying test files",
  "telemetry.sink": "`file` (local spool) or `none`",
  "telemetry.path": "a repo-relative directory, e.g. `.keel/telemetry`",
  "display.budget_ms": "milliseconds, 10–5000 — formatting past this is dropped",
};

function fixFor(path: string, issue: z.core.$ZodIssue): string {
  const direct = FIELD_HELP[path];
  if (direct !== undefined) return direct;

  if (issue.code === "unrecognized_keys") {
    const keys = "keys" in issue ? issue.keys.join(", ") : "";
    return `remove the unknown key${keys.includes(",") ? "s" : ""} (${keys}) — check for a typo against the documented schema`;
  }

  const parts = path.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const help = FIELD_HELP[parts.slice(0, i).join(".")];
    if (help !== undefined) return help;
  }
  return "see .keel/keel.config.schema.json for the accepted shape of this field";
}

export function issuesFrom(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((p) => String(p)).join(".") || "(root)";
    return { path, message: issue.message, fix: fixFor(path, issue) };
  });
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((i) => `  ${i.path}: ${i.message}\n    fix: ${i.fix}`).join("\n");
}

/** Validate an already-parsed object, strictly. */
export function validateConfig(raw: unknown): Result<KeelConfig, ConfigIssue[]> {
  const parsed = KeelConfigSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  return err(issuesFrom(parsed.error));
}

export interface LoadedConfig {
  readonly config: KeelConfig;
  readonly path: string;
}

/** Read and strictly validate `keel.config.yaml`. Used by check, init, doctor. */
export function loadConfigStrict(root: string): Result<LoadedConfig, ConfigIssue[]> {
  const path = configPath(root);
  if (!isFile(path)) {
    return err([
      {
        path: "(file)",
        message: `no ${path}`,
        fix: "run `keel init` in this repository to create one",
      },
    ]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    return err([
      { path: "(yaml)", message: errorMessage(cause), fix: "fix the YAML syntax error above" },
    ]);
  }

  const validated = validateConfig(raw);
  if (!validated.ok) return validated;
  return ok({ config: validated.value, path });
}

/** JSON Schema for editor integration, generated from the Zod schema. */
export function toJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(KeelConfigSchema, { io: "input" }) as Record<string, unknown>;
}
