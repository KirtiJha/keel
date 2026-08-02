import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { configPath, isFile } from "./paths.js";
import { asBool, asEnum, asEnumArray, asInt, asScore, asString, asStringArray, at } from "./validate.js";

/**
 * Config types, canonical defaults, and the **runtime** reader.
 *
 * Deliberately zod-free. Importing zod costs ~26 ms of module init (measured),
 * paid on every tool call, which is more than everything else a hook does put
 * together. The strict Zod schema lives in `config-schema.ts` and is loaded only
 * by `keel check`, `keel init`, and `SessionStart` — the places that are
 * supposed to fail loud, per constraint 0.9.
 *
 * `tests/shared/config-crosscheck.test.ts` runs the same corpus through both
 * and asserts identical output, so the fast path cannot drift from the schema.
 */

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const LANGUAGES = ["typescript", "python"] as const;
export type Language = (typeof LANGUAGES)[number];

export const TRACKS = ["quick", "standard", "full"] as const;
export type Track = (typeof TRACKS)[number];

export const TELEMETRY_SINKS = ["file", "none"] as const;
export type TelemetrySink = (typeof TELEMETRY_SINKS)[number];

export interface KeelConfig {
  readonly version: 1;
  readonly repo: {
    readonly name: string;
    readonly languages: readonly Language[];
  };
  readonly tracks: Readonly<Record<Track, { readonly effort: Effort }>>;
  readonly router: {
    readonly force_full_globs: readonly string[];
    readonly quick_max_files: number;
    readonly quick_max_lines: number;
    readonly escalate_caller_threshold: number;
    readonly package_roots: readonly string[];
  };
  readonly standards: {
    readonly packs_ref: string;
    readonly disabled: readonly string[];
    readonly dirs: readonly string[];
  };
  readonly tdd: {
    readonly enabled: boolean;
    readonly outer_loop: boolean;
    readonly exempt_globs: readonly string[];
    readonly test_globs: readonly string[];
  };
  readonly telemetry: {
    readonly sink: TelemetrySink;
    readonly path: string;
  };
  readonly upstream: {
    readonly enabled_skills: readonly string[];
    readonly disabled_skills: readonly string[];
  };
  readonly display: {
    readonly enabled: boolean;
    readonly budget_ms: number;
  };
  readonly spec: {
    /** Root of the OpenSpec working tree. */
    readonly dir: string;
    /** Plan rule 3: verbose specs are a defect. */
    readonly max_lines: number;
    /** Optional EARS acceptance criteria, full track only. Off until tried. */
    readonly ears: boolean;
    /** Full-track changes must have a proposal before implementation. */
    readonly require_proposal_on_full: boolean;
  };
  readonly mutation: {
    readonly enabled: boolean;
    /** Floor for killed/total on changed lines. Ratchets quarterly. */
    readonly min_score: number;
    /** Cap per run: mutation is slow and CI is not free. */
    readonly max_mutants: number;
    /** Per-mutant test timeout. */
    readonly timeout_ms: number;
    /** Test command. Detected from the repo when empty. */
    readonly test_command: string;
  };
}

/** Canonical defaults. The Zod schema's `.default()` values mirror these. */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.test.js",
  "**/*.spec.js",
  "**/test_*.py",
  "**/*_test.py",
  "**/tests/**/*.py",
];

export const DEFAULT_EXEMPT_GLOBS: readonly string[] = ["**/*.config.ts", "**/migrations/**"];
export const DEFAULT_PACKAGE_ROOTS: readonly string[] = ["packages/*", "services/*", "apps/*"];
export const DEFAULT_PACK_DIRS: readonly string[] = ["standards"];
export const DEFAULT_PACKS_REF = "keel-standards@0.1.0";
export const DEFAULT_TELEMETRY_PATH = ".keel/telemetry";
export const DEFAULT_SPEC_DIR = "openspec";
/** Plan: "Cap spec size at ~250 lines per change." */
export const DEFAULT_SPEC_MAX_LINES = 250;
/** Plan: "Starting floor ~50%, ratcheting quarterly." */
export const DEFAULT_MUTATION_MIN_SCORE = 0.5;
export const DEFAULT_MUTATION_MAX_MUTANTS = 40;
export const DEFAULT_MUTATION_TIMEOUT_MS = 120_000;

/** Superpowers skills enabled by default (build spec M2.4). */
export const DEFAULT_ENABLED_SKILLS: readonly string[] = [
  "test-driven-development",
  "systematic-debugging",
  "requesting-code-review",
  "receiving-code-review",
  "using-git-worktrees",
  "subagent-driven-development",
];

export function defaultConfig(
  repoName: string,
  languages: readonly Language[] = ["typescript"],
): KeelConfig {
  return {
    version: 1,
    repo: { name: repoName, languages: [...languages] },
    tracks: {
      quick: { effort: "low" },
      standard: { effort: "medium" },
      full: { effort: "high" },
    },
    router: {
      force_full_globs: [],
      quick_max_files: 1,
      quick_max_lines: 50,
      escalate_caller_threshold: 5,
      package_roots: [...DEFAULT_PACKAGE_ROOTS],
    },
    standards: {
      packs_ref: DEFAULT_PACKS_REF,
      disabled: [],
      dirs: [...DEFAULT_PACK_DIRS],
    },
    tdd: {
      enabled: true,
      // Integration TDD. Ships false; see keel-plan.md "Deferred".
      outer_loop: false,
      exempt_globs: [...DEFAULT_EXEMPT_GLOBS],
      test_globs: [...DEFAULT_TEST_GLOBS],
    },
    telemetry: { sink: "file", path: DEFAULT_TELEMETRY_PATH },
    upstream: { enabled_skills: [...DEFAULT_ENABLED_SKILLS], disabled_skills: [] },
    display: { enabled: true, budget_ms: 100 },
    spec: {
      dir: DEFAULT_SPEC_DIR,
      max_lines: DEFAULT_SPEC_MAX_LINES,
      ears: false,
      require_proposal_on_full: true,
    },
    mutation: {
      enabled: true,
      min_score: DEFAULT_MUTATION_MIN_SCORE,
      max_mutants: DEFAULT_MUTATION_MAX_MUTANTS,
      timeout_ms: DEFAULT_MUTATION_TIMEOUT_MS,
      test_command: "",
    },
  };
}

/**
 * Coerce arbitrary parsed YAML into a usable config.
 *
 * Never throws and never rejects: any field that is missing or malformed falls
 * back to its default. A developer mid-edit on their config must not have every
 * gate in the repo start failing.
 */
export function readConfigValue(raw: unknown, repoName = "unknown"): KeelConfig {
  const base = defaultConfig(repoName);
  const name = asString(at(raw, "repo", "name"), base.repo.name);
  const languages = asEnumArray(at(raw, "repo", "languages"), LANGUAGES, base.repo.languages);

  const effort = (track: Track): Effort =>
    asEnum(at(raw, "tracks", track, "effort"), EFFORTS, base.tracks[track].effort);

  return {
    version: 1,
    repo: { name, languages },
    tracks: {
      quick: { effort: effort("quick") },
      standard: { effort: effort("standard") },
      full: { effort: effort("full") },
    },
    router: {
      force_full_globs: asStringArray(at(raw, "router", "force_full_globs"), base.router.force_full_globs),
      quick_max_files: asInt(at(raw, "router", "quick_max_files"), base.router.quick_max_files, 1),
      quick_max_lines: asInt(at(raw, "router", "quick_max_lines"), base.router.quick_max_lines, 1),
      escalate_caller_threshold: asInt(
        at(raw, "router", "escalate_caller_threshold"),
        base.router.escalate_caller_threshold,
        0,
      ),
      package_roots: asStringArray(at(raw, "router", "package_roots"), base.router.package_roots),
    },
    standards: {
      packs_ref: asString(at(raw, "standards", "packs_ref"), base.standards.packs_ref),
      // An explicitly empty disabled list is meaningful, so it is not defaulted.
      disabled: Array.isArray(at(raw, "standards", "disabled"))
        ? asStringArray(at(raw, "standards", "disabled"), [])
        : [...base.standards.disabled],
      dirs: asStringArray(at(raw, "standards", "dirs"), base.standards.dirs),
    },
    tdd: {
      enabled: asBool(at(raw, "tdd", "enabled"), base.tdd.enabled),
      outer_loop: asBool(at(raw, "tdd", "outer_loop"), base.tdd.outer_loop),
      exempt_globs: Array.isArray(at(raw, "tdd", "exempt_globs"))
        ? asStringArray(at(raw, "tdd", "exempt_globs"), [])
        : [...base.tdd.exempt_globs],
      test_globs: asStringArray(at(raw, "tdd", "test_globs"), base.tdd.test_globs),
    },
    telemetry: {
      sink: asEnum(at(raw, "telemetry", "sink"), TELEMETRY_SINKS, base.telemetry.sink),
      path: asString(at(raw, "telemetry", "path"), base.telemetry.path),
    },
    upstream: {
      enabled_skills: asStringArray(at(raw, "upstream", "enabled_skills"), base.upstream.enabled_skills),
      disabled_skills: Array.isArray(at(raw, "upstream", "disabled_skills"))
        ? asStringArray(at(raw, "upstream", "disabled_skills"), [])
        : [...base.upstream.disabled_skills],
    },
    display: {
      enabled: asBool(at(raw, "display", "enabled"), base.display.enabled),
      budget_ms: Math.min(5000, Math.max(10, asInt(at(raw, "display", "budget_ms"), base.display.budget_ms, 10))),
    },
    spec: {
      dir: asString(at(raw, "spec", "dir"), base.spec.dir),
      max_lines: asInt(at(raw, "spec", "max_lines"), base.spec.max_lines, 1),
      ears: asBool(at(raw, "spec", "ears"), base.spec.ears),
      require_proposal_on_full: asBool(
        at(raw, "spec", "require_proposal_on_full"),
        base.spec.require_proposal_on_full,
      ),
    },
    mutation: {
      enabled: asBool(at(raw, "mutation", "enabled"), base.mutation.enabled),
      min_score: asScore(at(raw, "mutation", "min_score"), base.mutation.min_score),
      max_mutants: asInt(at(raw, "mutation", "max_mutants"), base.mutation.max_mutants, 1),
      timeout_ms: asInt(at(raw, "mutation", "timeout_ms"), base.mutation.timeout_ms, 1000),
      test_command: asString(at(raw, "mutation", "test_command"), base.mutation.test_command),
    },
  };
}

export interface ResolvedConfig {
  readonly config: KeelConfig;
  /** False when no config file exists — callers may want to prompt for init. */
  readonly present: boolean;
}

/**
 * The runtime entry point. Reads `keel.config.yaml` if present, coerces it, and
 * always returns something usable.
 */
export function loadConfigOrDefaults(root: string, repoName?: string): ResolvedConfig {
  const path = configPath(root);
  const fallbackName = repoName ?? root.split(/[\\/]/).pop() ?? "unknown";

  if (!isFile(path)) {
    return { config: defaultConfig(fallbackName), present: false };
  }

  try {
    const raw: unknown = parseYaml(readFileSync(path, "utf8"));
    return { config: readConfigValue(raw, fallbackName), present: true };
  } catch {
    // Unparseable YAML degrades to defaults; `keel check` reports it loudly.
    return { config: defaultConfig(fallbackName), present: true };
  }
}
