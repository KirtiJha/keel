import { loadConfigOrDefaults } from "../../shared/config.js";
import { loadPacks } from "../../standards/loader.js";
import {
  TRUST_FILE,
  isPluginPack,
  listUntrustedRules,
  trustRule,
  untrustRule,
} from "../../standards/trust.js";
import { keelSubdir } from "../../shared/paths.js";
import { bold, detail, dim, fatal, fatalDetail, heading, info, json, line, ok, warn } from "../output.js";

/**
 * `keel trust [list|add <pack>|remove <pack>]`.
 *
 * A repo-local pack's `rule.ts` is code the PostToolUse hook executes
 * automatically on files a developer edits. Cloning a repository and opening a
 * file should not be enough to run it. `src/standards/trust.ts` owns the
 * mechanism and the decision; this is the human-driven half — what would run,
 * where it lives, what it hashes to, and an explicit `add` to allow it.
 *
 * Hooks never prompt, which is exactly why approval needs a command.
 */

export interface TrustOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly subcommand: string | null;
  /** Pack name for `add` / `remove`. */
  readonly pack: string | null;
  readonly json: boolean;
  readonly all: boolean;
}

function scopeOf(options: TrustOptions): {
  repoRoot: string;
  pluginRoot: string;
  config: ReturnType<typeof loadConfigOrDefaults>["config"];
} {
  return {
    repoRoot: options.repoRoot,
    pluginRoot: options.pluginRoot,
    config: loadConfigOrDefaults(options.repoRoot).config,
  };
}

function storePath(repoRoot: string): string {
  return keelSubdir(repoRoot, TRUST_FILE);
}

export function trust(options: TrustOptions): number {
  switch (options.subcommand) {
    case "list":
    case null:
      return trustList(options);
    case "add":
      return trustAdd(options);
    case "remove":
      return trustRemove(options);
    default:
      fatal(`unknown subcommand \`${options.subcommand}\` for \`keel trust\``);
      fatalDetail("expected one of: list, add, remove");
      return 1;
  }
}

/** Repo-local packs that ship an executable rule, approved or not. */
function repoLocalPacks(options: TrustOptions): Array<{ name: string; files: string[] }> {
  const scope = scopeOf(options);
  return loadPacks(scope.repoRoot, scope.pluginRoot, scope.config)
    .packs.filter((p) => !isPluginPack(p, scope.pluginRoot))
    .filter((p) => p.ruleTsPath !== null || p.rulePyPath !== null)
    .map((p) => ({
      name: p.standard.name,
      files: [p.ruleTsPath, p.rulePyPath].filter((f): f is string => f !== null),
    }));
}

function trustList(options: TrustOptions): number {
  const untrusted = listUntrustedRules(scopeOf(options));
  const local = repoLocalPacks(options);
  const blocked = new Set(untrusted.map((r) => r.pack));

  if (options.json) {
    json({
      store: storePath(options.repoRoot),
      packs: local.map((p) => ({ pack: p.name, trusted: !blocked.has(p.name) })),
      untrusted,
      untrustedCount: untrusted.length,
    });
    return untrusted.length > 0 ? 1 : 0;
  }

  heading("Repo-local pack rules");
  if (local.length === 0) {
    info("none — every standards pack visible here ships with the plugin");
    detail("only rules that arrive in a checkout need approval; the plugin's own do not");
    line();
    return 0;
  }

  for (const rule of untrusted) {
    warn(`${bold(rule.pack)}  ${dim(rule.file)}`);
    detail(`${rule.reason} (${rule.mode} pack, owner ${rule.owner})`);
    detail(rule.description);
    detail(`sha256:${rule.sha256 === null ? "unreadable" : rule.sha256.slice(0, 16)}`);
    detail(`read the file, then: keel trust add ${rule.pack}`);
  }
  for (const pack of local) {
    if (blocked.has(pack.name)) continue;
    ok(`${bold(pack.name)}  ${dim(pack.files.join(", "))}`);
    detail("approved — its rule runs on matching edits");
  }

  heading("Summary");
  if (untrusted.length === 0) {
    ok(`${local.length} repo-local pack${local.length === 1 ? "" : "s"}, all approved`);
    line();
    return 0;
  }
  warn(`${untrusted.length} rule${untrusted.length === 1 ? "" : "s"} will not run until approved`);
  detail(`approvals live in ${storePath(options.repoRoot)}, which is gitignored — trust is per checkout, not something a repository grants itself`);
  line();
  return 1;
}

function trustAdd(options: TrustOptions): number {
  const scope = scopeOf(options);
  const targets = options.all
    ? [...new Set(listUntrustedRules(scope).map((r) => r.pack))]
    : options.pack === null
      ? []
      : [options.pack];

  if (targets.length === 0) {
    if (options.all) {
      if (options.json) {
        json({ store: storePath(options.repoRoot), results: [] });
        return 0;
      }
      heading("Trust");
      info("nothing to approve — every repo-local rule is already trusted");
      line();
      return 0;
    }
    fatal("`keel trust add` needs a pack name");
    fatalDetail("run `keel trust list` to see what is awaiting approval, then `keel trust add <pack>`");
    return 1;
  }

  const results: Array<{ pack: string; approved: number; error?: string }> = [];
  let failures = 0;

  for (const pack of targets) {
    const result = trustRule(scope, pack);
    if (!result.ok) {
      failures++;
      results.push({ pack, approved: 0, error: result.error });
      continue;
    }
    results.push({ pack, approved: result.value.length });
  }

  if (options.json) {
    json({ store: storePath(options.repoRoot), results });
    return failures > 0 ? 1 : 0;
  }

  if (failures > 0) {
    for (const entry of results) {
      if (entry.error === undefined) continue;
      fatal(entry.error);
    }
    fatalDetail("run `keel trust list` to see the repo-local packs this checkout carries");
    return 1;
  }

  heading("Trust");
  for (const entry of results) {
    ok(`${entry.pack} approved (${entry.approved} rule file${entry.approved === 1 ? "" : "s"}) — it may now run`);
  }
  line();
  return 0;
}

function trustRemove(options: TrustOptions): number {
  if (options.pack === null) {
    fatal("`keel trust remove` needs a pack name");
    fatalDetail("run `keel trust list` to see which packs are approved");
    return 1;
  }

  const result = untrustRule(options.repoRoot, options.pack);
  if (!result.ok) {
    fatal(result.error);
    fatalDetail(`check that ${storePath(options.repoRoot)} is writable`);
    return 1;
  }

  if (options.json) {
    json({ pack: options.pack, removed: result.value });
    return 0;
  }

  heading("Trust");
  if (result.value > 0) {
    ok(`${options.pack} approval withdrawn — its rule will not run`);
  } else {
    info(`${options.pack} was not approved, so nothing changed`);
  }
  line();
  return 0;
}
