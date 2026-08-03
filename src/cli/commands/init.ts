import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { loadConfigStrict, toJsonSchema } from "../../shared/config-schema.js";
import { defaultConfig } from "../../shared/config.js";
import { isGitRepo } from "../../shared/git.js";
import { configPath, isDirectory, isFile } from "../../shared/paths.js";
import { detectLanguages } from "../../context/commands.js";
import { writeClaudeMd } from "../../context/claudemd.js";
import { scanGotchas, type GotchaCandidate } from "../../context/gotchas.js";
import { loadPacks } from "../../standards/loader.js";
import { mergeObjectKey, updateSettings } from "../../shared/settings.js";
import { lockPath } from "../../upstream/lock.js";
import { applySkillSubset, hasInstallableUpstream, upstreamInstallWarnings } from "./upstream.js";
import { bold, detail, heading, info, line, ok, warn } from "../output.js";

/**
 * `keel init` — set a repository up.
 *
 * Idempotent, and never clobbers hand-edited content (M9.5). Every file it
 * touches is either created fresh or edited only between managed markers, so
 * running it twice is a no-op and running it after a hand edit keeps the edit.
 */

export interface InitOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  /** Gotchas a human confirmed. The scanner never writes unreviewed entries. */
  readonly confirmedGotchas?: readonly GotchaCandidate[];
  readonly force?: boolean;
  /**
   * Report which pinned upstream dependencies are missing. Default true;
   * `--no-install` skips the report. Init never installs anything — see the
   * module comment on `keel upstream`.
   */
  readonly install?: boolean;
}

const GITIGNORE_ENTRY = ".keel/";

function ensureGitignore(root: string): "added" | "present" | "created" {
  const path = join(root, ".gitignore");
  if (!isFile(path)) {
    writeFileSync(path, `${GITIGNORE_ENTRY}\n`, "utf8");
    return "created";
  }

  const text = readFileSync(path, "utf8");
  if (text.split("\n").some((l) => l.trim() === GITIGNORE_ENTRY)) return "present";

  writeFileSync(path, `${text}${text.endsWith("\n") ? "" : "\n"}${GITIGNORE_ENTRY}\n`, "utf8");
  return "added";
}

/** A YAML block sequence of quoted strings, at one indent level. */
function items(values: readonly string[], indent = "    "): string[] {
  return values.map((value) => `${indent}- ${JSON.stringify(value)}`);
}

function writeConfig(root: string, force: boolean): "created" | "kept" {
  const path = configPath(root);
  if (isFile(path) && !force) return "kept";

  const languages = detectLanguages(root);
  const name = basename(root);
  // Values come from the canonical defaults rather than being retyped here, so
  // the scaffold cannot drift from what Keel actually falls back to. It wrote 6
  // of 10 sections for a while, and `mutation.test_command` was discoverable
  // only from the error message you got when mutation testing could not find a
  // test command.
  const base = defaultConfig(name, languages);

  // Written by hand rather than serialised so the file carries comments
  // explaining each knob — a config nobody understands is a config nobody tunes.
  const yaml = [
    "# Keel configuration. Schema: .keel/keel.config.schema.json",
    "#",
    "# Every section Keel reads is written out at its default, with the comment",
    "# that explains the knob. Deleting a field is safe: it falls back to exactly",
    "# the value shown here.",
    "version: 1",
    "",
    "repo:",
    `  name: ${name}`,
    `  languages: [${languages.join(", ")}]`,
    "",
    "# Reasoning effort per track.",
    "tracks:",
    "  quick:    { effort: low }",
    "  standard: { effort: medium }",
    "  full:     { effort: high }",
    "",
    "router:",
    "  # Any change touching these is always full track.",
    "  force_full_globs:",
    '    - "**/migrations/**"',
    '    - "**/auth/**"',
    '    - "openapi/**"',
    "  # At or under both of these, a change may stay on the quick track.",
    `  quick_max_files: ${base.router.quick_max_files}`,
    `  quick_max_lines: ${base.router.quick_max_lines}`,
    "  # Past either of these a change is full track on size alone. Deliberately",
    "  # high: the common large change is a rename or a formatting sweep.",
    `  standard_max_files: ${base.router.standard_max_files}`,
    `  standard_max_lines: ${base.router.standard_max_lines}`,
    "  # More external callers than this escalates off the quick track.",
    `  escalate_caller_threshold: ${base.router.escalate_caller_threshold}`,
    "  # Monorepo layout: a change spanning two of these roots is cross-package.",
    "  package_roots:",
    ...items(base.router.package_roots),
    "",
    "standards:",
    `  packs_ref: ${JSON.stringify(base.standards.packs_ref)}`,
    "  # Pack names to switch off in this repo.",
    "  disabled: []",
    "  # Where packs are looked for, relative to this repository. A rule found",
    "  # here is repo-local code: it runs only after `keel trust add <pack>`.",
    "  dirs:",
    ...items(base.standards.dirs),
    "",
    "tdd:",
    "  enabled: true",
    "  # Integration TDD. Off until a harness exists; see keel-plan.md.",
    "  outer_loop: false",
    "  # Files no TDD gate applies to.",
    "  exempt_globs:",
    '    - "**/*.config.ts"',
    '    - "**/migrations/**"',
    "  # What counts as a test file, for the pairing and observed-RED gates.",
    "  test_globs:",
    ...items(base.tdd.test_globs),
    "",
    "telemetry:",
    "  # `file` spools to `path` and never leaves this machine; `none` records",
    "  # nothing, and the gate hit rates in `keel doctor` go with it.",
    "  sink: file",
    `  path: ${JSON.stringify(base.telemetry.path)}`,
    "",
    "# Superpowers skills Keel switches on, and any it must leave off.",
    "upstream:",
    "  enabled_skills:",
    ...items(base.upstream.enabled_skills),
    "  disabled_skills: []",
    "",
    "display:",
    "  enabled: true",
    "  # Formatting past this budget is dropped rather than delaying output.",
    `  budget_ms: ${base.display.budget_ms}`,
    "",
    "spec:",
    "  # Root of the OpenSpec working tree.",
    `  dir: ${base.spec.dir}`,
    "  # A verbose spec is a defect: cap the lines per change.",
    `  max_lines: ${base.spec.max_lines}`,
    "  # Optional EARS acceptance criteria, full track only. Off until tried.",
    "  ears: false",
    "  # A full-track change needs a proposal before implementation.",
    "  require_proposal_on_full: true",
    "",
    "mutation:",
    "  enabled: true",
    "  # Floor for killed/total on changed lines. Ratchets quarterly.",
    `  min_score: ${base.mutation.min_score}`,
    "  # Cap per run: mutation is slow and CI is not free.",
    `  max_mutants: ${base.mutation.max_mutants}`,
    "  # Per-mutant test timeout.",
    `  timeout_ms: ${base.mutation.timeout_ms}`,
    '  # How to run the tests, e.g. "npm test". Detected from the repo when empty.',
    '  test_command: ""',
    "",
  ].join("\n");

  writeFileSync(path, yaml, "utf8");
  return "created";
}

/**
 * Where the subagent templates live.
 *
 * **Not** `<plugin>/agents/`. Claude Code auto-discovers that directory at
 * plugin root when `plugin.json` declares no `agents` key — which is this
 * plugin's situation — and plugin-shipped agents do not support `hooks`,
 * `mcpServers` or `permissionMode`. `keel-reviewer` declares `permissionMode`,
 * so the plugin-scanned copy was invalid, and `installAgents` copied the same
 * file into `.claude/agents/` where the field *is* supported: one agent,
 * registered twice, one of them broken. Keeping the template outside the
 * auto-scanned path leaves exactly one registration — the working one.
 */
const AGENT_TEMPLATE_DIRS: readonly string[] = [
  join("templates", "agents"),
  join("src", "cli", "templates", "agents"),
];

function agentTemplateDir(pluginRoot: string): string | null {
  for (const candidate of AGENT_TEMPLATE_DIRS) {
    const dir = join(pluginRoot, candidate);
    if (isDirectory(dir)) return dir;
  }
  return null;
}

/**
 * Install subagent definitions into `.claude/agents/` (M9.3).
 *
 * A file a human has edited is left alone: same rule as CLAUDE.md.
 */
function installAgents(repoRoot: string, pluginRoot: string): string[] {
  const source = agentTemplateDir(pluginRoot);
  if (source === null) return [];

  const target = join(repoRoot, ".claude", "agents");
  const installed: string[] = [];

  try {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (!name.endsWith(".md")) continue;
      const from = join(source, name);
      const to = join(target, name);
      const content = readFileSync(from, "utf8");

      if (isFile(to)) {
        if (readFileSync(to, "utf8") === content) continue;
        // Present and different: a hand edit. Leave it.
        continue;
      }

      writeFileSync(to, content, "utf8");
      installed.push(name);
    }
  } catch {
    return installed;
  }

  return installed;
}

/**
 * Merge Keel's environment into `.claude/settings.json` (M2.5).
 *
 * Merged rather than written: settings.json is a shared file and a developer's
 * own keys must survive. Only the specific variables Keel owns are touched, and
 * an existing value is left alone — if someone has deliberately set
 * `SUPERPOWERS_DISABLE_TELEMETRY=0`, that is their call, not ours to reverse.
 */
const KEEL_ENV: Readonly<Record<string, string>> = {
  // Build spec M2.5. Upstream telemetry is not ours to send.
  SUPERPOWERS_DISABLE_TELEMETRY: "1",
};

function writeSettingsEnv(root: string): string {
  const written = updateSettings(root, "project", (current) =>
    mergeObjectKey(current, "env", KEEL_ENV),
  );
  return written.ok ? written.value : "unchanged";
}

/**
 * A starter `upstream.lock`.
 *
 * Every message that mentions a missing lock told people to run `keel init` —
 * and `keel init` did nothing about it, so `keel check` and `keel doctor` carried
 * a permanent warning with no remedy. Init now creates the file, which makes
 * those messages true.
 *
 * It is created *empty of dependencies* and full of instructions. Guessing a
 * repository's upstream toolchain would be inventing pins, and a wrong pin is
 * worse than an absent one — `keel check` rejects moving versions precisely so
 * nobody ends up with a toolchain that drifts.
 */
const LOCK_TEMPLATE = [
  "# Pinned upstream toolchains this repository composes.",
  "#",
  "# Rule of the road 6: compose, don't fork. Pin exact versions, mirror them",
  "# internally, never patch.",
  "# Rule of the road 7: one owner per phase.",
  "#",
  "# `keel check` enforces both. It rejects moving versions (`latest`, `^1.2.0`,",
  "# `main`) and cross-checks every `owns:` entry against the phase-ownership map,",
  "# so two dependencies claiming one phase is an error rather than a surprise.",
  "#",
  "# `keel upstream status` reports what is actually installed;",
  "# `keel upstream install` runs the `install:` command recorded below, verbatim.",
  "version: 1",
  "",
  "dependencies: {}",
  "",
  "# Worked example — delete the `{}` above and uncomment to pin something:",
  "#",
  "# dependencies:",
  "#   openspec:",
  '#     version: "1.7.0"          # exact. A range or `latest` fails `keel check`.',
  '#     source: "@fission-ai/openspec"',
  "#     role: install             # or `pattern-source` for an idea we copied",
  '#     install: "npm install --save-exact @fission-ai/openspec@1.7.0"',
  '#     mirror: "internal-registry/@fission-ai/openspec@1.7.0"',
  "#     owns: [design, spec-conformance]",
  "#     note: >-",
  "#       Why this version, and why this tool owns those phases.",
  "",
].join("\n");

function writeLock(root: string, force: boolean): "created" | "kept" {
  const path = lockPath(root);
  if (isFile(path) && !force) return "kept";
  writeFileSync(path, LOCK_TEMPLATE, "utf8");
  return "created";
}

function writeSchema(root: string): void {
  const dir = join(root, ".keel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "keel.config.schema.json"),
    `${JSON.stringify(toJsonSchema(), null, 2)}\n`,
    "utf8",
  );
}

export function init(options: InitOptions): number {
  const { repoRoot, pluginRoot } = options;
  /** Files this run created, so the Next block can tell the user to commit them. */
  const created: string[] = [];

  heading("keel init");

  // ---- git ----
  // `check` reports "not a git repository — diff-only gates cannot run" after
  // the fact. Saying it here, where the fix is one command, is cheaper than
  // finishing with all-green ticks over a repository where half of Keel is
  // inert: gates evaluate changed lines, and without git there are none.
  const git = isGitRepo(repoRoot);
  if (!git) {
    warn(`${repoRoot} is not a git repository — diff-only gates and the router cannot run here`);
    detail('fix: git init && git add -A && git commit -m "initial"');
  }

  // ---- config ----
  const configAction = writeConfig(repoRoot, options.force === true);
  if (configAction === "created") {
    ok(`wrote ${configPath(repoRoot)}`);
    created.push("keel.config.yaml");
  } else info("keel.config.yaml already exists — kept (use --force to overwrite)");

  const loaded = loadConfigStrict(repoRoot);
  if (!loaded.ok) {
    warn("the config on disk is invalid; using defaults for the rest of init");
  }
  const config = loaded.ok
    ? loaded.value.config
    : defaultConfig(basename(repoRoot), detectLanguages(repoRoot));

  // ---- generated JSON Schema, for editor completion ----
  writeSchema(repoRoot);
  ok("wrote .keel/keel.config.schema.json");

  // ---- upstream.lock ----
  const lockAction = writeLock(repoRoot, options.force === true);
  if (lockAction === "created") {
    ok("wrote upstream.lock (no dependencies pinned yet — the file explains how)");
    created.push("upstream.lock");
  } else info("upstream.lock already exists — kept (use --force to overwrite)");

  // ---- gitignore ----
  const ignoreAction = ensureGitignore(repoRoot);
  if (ignoreAction === "present") info(".gitignore already ignores .keel/");
  else {
    ok(`${ignoreAction === "created" ? "created" : "updated"} .gitignore for .keel/`);
    created.push(".gitignore");
  }

  // ---- CLAUDE.md ----
  const guidePacks = loadPacks(repoRoot, pluginRoot, config)
    .packs.filter((p) => p.standard.mode === "guide")
    .map((p) => p.standard.name);

  const claudeMd = writeClaudeMd({
    root: repoRoot,
    config,
    confirmedGotchas: options.confirmedGotchas ?? [],
    guidePacks,
  });

  if (claudeMd.action === "unchanged") info("CLAUDE.md already up to date");
  else {
    ok(`CLAUDE.md ${claudeMd.action}`);
    created.push("CLAUDE.md");
  }

  // ---- environment for upstream tools (M2.5) ----
  const settings = writeSettingsEnv(repoRoot);
  if (settings === "unchanged") info(".claude/settings.json already has Keel's environment");
  else {
    ok(`.claude/settings.json ${settings} (SUPERPOWERS_DISABLE_TELEMETRY=1)`);
    created.push(".claude/settings.json");
  }

  // ---- skill subset (M2.4) ----
  for (const note of applySkillSubset(repoRoot)) info(note);

  // ---- subagents needing privileged frontmatter ----
  const agents = installAgents(repoRoot, pluginRoot);
  if (agents.length > 0) {
    ok(`installed ${agents.length} agent(s) to .claude/agents/`);
    created.push(".claude/agents/");
  } else info(".claude/agents/ already up to date");

  // ---- gotchas: propose, never write ----
  const candidates = scanGotchas(repoRoot, { max: 10 });
  if (candidates.length > 0 && (options.confirmedGotchas ?? []).length === 0) {
    heading("Gotcha candidates");
    line(
      "  These are proposals. None has been written — run `keel gotchas` to review\n" +
        "  and confirm them one at a time.",
    );
    line();
    for (const candidate of candidates.slice(0, 5)) {
      info(`${candidate.path}${candidate.line === undefined ? "" : `:${candidate.line}`} (${candidate.confidence})`);
      detail(candidate.evidence);
    }
    if (candidates.length > 5) info(`…and ${candidates.length - 5} more`);
  }

  // ---- upstream (M2.2) ----
  // init reports, it never installs: `keel upstream install` runs commands out
  // of upstream.lock and can register a plugin marketplace, and that is not a
  // side effect of scaffolding a config file. `--no-install` skips this report.
  if (options.install !== false && hasInstallableUpstream(repoRoot)) {
    heading("Upstream");
    const warnings = upstreamInstallWarnings(repoRoot);
    if (warnings.length === 0) {
      ok("pinned set already installed");
    } else {
      for (const text of warnings) info(text);
      detail("`keel init` does not install — run `keel upstream install` to bring them to their pins");
    }
  }

  heading("Next");
  // Rule of the road 1: the quick track has to feel invisible. Leaving init's
  // own files uncommitted put six new files and ~115 lines into the next
  // `keel route`, which escalated an unrelated one-line change to the standard
  // track — Keel's setup taxing the first change someone makes with it.
  let step = 1;
  if (created.length > 0 && git) {
    line(`  ${step++}. ${bold("commit these files")} — they are Keel's setup, not your change:`);
    line(`     git add ${created.join(" ")} && git commit -m "chore: keel init"`);
    line("     (uncommitted, they route your next change to the standard track)");
  }
  line(`  ${step++}. \`keel check\`     validate config, packs and pins`);
  line(`  ${step++}. \`keel gotchas\`   review and confirm gotcha candidates`);
  line(`  ${step}. \`keel doctor\`    see what is active and how fast it runs`);
  line();

  return 0;
}
