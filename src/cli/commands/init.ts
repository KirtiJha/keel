import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { loadConfigStrict, toJsonSchema } from "../../shared/config-schema.js";
import { defaultConfig } from "../../shared/config.js";
import { configPath, isDirectory, isFile } from "../../shared/paths.js";
import { detectLanguages } from "../../context/commands.js";
import { writeClaudeMd } from "../../context/claudemd.js";
import { scanGotchas, type GotchaCandidate } from "../../context/gotchas.js";
import { loadPacks } from "../../standards/loader.js";
import { detail, heading, info, line, ok, warn } from "../output.js";

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

function writeConfig(root: string, force: boolean): "created" | "kept" {
  const path = configPath(root);
  if (isFile(path) && !force) return "kept";

  const languages = detectLanguages(root);
  const name = basename(root);

  // Written by hand rather than serialised so the file carries comments
  // explaining each knob — a config nobody understands is a config nobody tunes.
  const yaml = [
    "# Keel configuration. Schema: .keel/keel.config.schema.json",
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
    "  quick_max_files: 1",
    "  quick_max_lines: 50",
    "  # More external callers than this escalates off the quick track.",
    "  escalate_caller_threshold: 5",
    "",
    "standards:",
    '  packs_ref: "keel-standards@0.1.0"',
    "  # Pack names to switch off in this repo.",
    "  disabled: []",
    "",
    "tdd:",
    "  enabled: true",
    "  # Integration TDD. Off until a harness exists; see keel-plan.md.",
    "  outer_loop: false",
    "  exempt_globs:",
    '    - "**/*.config.ts"',
    '    - "**/migrations/**"',
    "",
    "telemetry:",
    "  sink: file",
    '  path: ".keel/telemetry"',
    "",
  ].join("\n");

  writeFileSync(path, yaml, "utf8");
  return "created";
}

/**
 * Install subagent definitions into `.claude/agents/` (M9.3).
 *
 * Plugin-packaged subagents do not support `hooks`, `mcpServers` or
 * `permissionMode` frontmatter, so any agent that needs those has to be
 * installed into the repo rather than shipped inside the plugin. `keel-reviewer`
 * sets `permissionMode`, which is why it lives here.
 *
 * A file a human has edited is left alone: same rule as CLAUDE.md.
 */
function installAgents(repoRoot: string, pluginRoot: string): string[] {
  const source = join(pluginRoot, "agents");
  if (!isDirectory(source)) return [];

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

  heading("keel init");

  // ---- config ----
  const configAction = writeConfig(repoRoot, options.force === true);
  if (configAction === "created") ok(`wrote ${configPath(repoRoot)}`);
  else info("keel.config.yaml already exists — kept (use --force to overwrite)");

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

  // ---- gitignore ----
  const ignoreAction = ensureGitignore(repoRoot);
  if (ignoreAction === "present") info(".gitignore already ignores .keel/");
  else ok(`${ignoreAction === "created" ? "created" : "updated"} .gitignore for .keel/`);

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
  else ok(`CLAUDE.md ${claudeMd.action}`);

  // ---- subagents needing privileged frontmatter ----
  const agents = installAgents(repoRoot, pluginRoot);
  if (agents.length > 0) ok(`installed ${agents.length} agent(s) to .claude/agents/`);
  else info(".claude/agents/ already up to date");

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

  heading("Next");
  line("  1. `keel check`     validate config, packs and pins");
  line("  2. `keel gotchas`   review and confirm gotcha candidates");
  line("  3. `keel doctor`    see what is active and how fast it runs");
  line();

  return 0;
}
