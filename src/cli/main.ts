import { PLUGIN_VERSION } from "../telemetry/spool.js";
import { repoRootOrCwd } from "../shared/paths.js";
import { setLogRoot } from "../shared/log.js";
import { errorMessage } from "../shared/result.js";
import { pluginRoot } from "../hooks/context.js";
import type { Track } from "../shared/config.js";

import { flagBool, flagPresent, flagString, parseArgs, suggest, type ParsedArgs } from "./args.js";
import {
  COMMANDS,
  COMMAND_NAMES,
  commandSpec,
  validateFlags,
  validateSubcommand,
  valueFlagNames,
  type CommandSpec,
} from "./registry.js";
import { resolveRef } from "./git-ref.js";
import { check } from "./commands/check.js";
import { doctor } from "./commands/doctor.js";
import { gate } from "./commands/gate.js";
import { gotchas } from "./commands/gotchas.js";
import { init } from "./commands/init.js";
import { mutate } from "./commands/mutate.js";
import { recordReview, review } from "./commands/review.js";
import { route } from "./commands/route.js";
import { spec } from "./commands/spec.js";
import { telemetry } from "./commands/telemetry.js";
import { trust } from "./commands/trust.js";
import { upstream } from "./commands/upstream.js";
import { bold, dim, fatal, fatalDetail, line } from "./output.js";

/**
 * The usage screen, rendered from the command registry.
 *
 * Written out by hand it drifted: four flags `review record` actually reads
 * (`--human-comments`, `--bot-comments`, `--reviews`, `--changed-files`) were
 * missing from it entirely. Generating it from the same table the validator
 * uses means a flag cannot exist without being documented.
 */
export function usage(): string {
  const commandWidth = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;

  const commandLines: string[] = [];
  for (const command of COMMANDS) {
    if (command.name === "help") continue;
    commandLines.push(`  ${command.name.padEnd(commandWidth)}${command.summary}`);
    if (command.usage !== undefined) {
      commandLines.push(`  ${" ".repeat(commandWidth)}${dim(command.usage)}`);
    }
  }

  // One row per flag, with the commands that accept it. A flag nobody can use
  // is a flag that should not be listed.
  const owners = new Map<string, { flag: (typeof COMMANDS)[number]["flags"][number]; commands: string[] }>();
  for (const command of COMMANDS) {
    if (command.name === "help" || command.name === "version") continue;
    for (const flag of command.flags) {
      const entry = owners.get(flag.name);
      if (entry === undefined) owners.set(flag.name, { flag, commands: [command.name] });
      else entry.commands.push(command.name);
    }
  }

  const rendered = [...owners.values()].map(({ flag, commands }) => ({
    left: `--${flag.name}${flag.value === undefined ? "" : ` ${flag.value}`}`,
    // Naming every command for a flag that is on almost all of them is noise;
    // naming them for a flag on one or two is the whole point. A help string
    // that already names its command does not need the annotation repeated.
    right: `${flag.help}${commands.length > 3 || flag.help.includes(commands[0] ?? "") ? "" : ` ${dim(`(${commands.join(", ")})`)}`}`,
  }));
  const optionWidth = Math.max(...rendered.map((r) => r.left.length)) + 2;
  const optionLines = rendered.map((r) => `  ${r.left.padEnd(optionWidth)}${r.right}`);

  return `
${bold("keel")} — spec-driven development for Claude Code

${bold("Usage")}
  keel <command> [options]

${bold("Commands")}
${commandLines.join("\n")}

${bold("Options")}
${optionLines.join("\n")}
  ${"--help".padEnd(optionWidth)}show this screen (-h)
  ${"--version".padEnd(optionWidth)}print the plugin version (-v)

${dim("Docs: README.md")}
`;
}

function parseTrack(value: string | null): Track | null {
  if (value === "quick" || value === "standard" || value === "full") return value;
  return null;
}

/**
 * A count flag, or an error naming it.
 *
 * `keel review record --human-comments abc` used to coerce to 0 and report a
 * clean PR. That number is the project's headline metric; silently recording
 * the wrong one is worse than refusing.
 */
function parseCount(args: ParsedArgs, name: string): number | string {
  const raw = args.flags[name];
  if (raw === undefined) return 0;
  if (raw === true) return `\`--${name}\` needs a number, e.g. \`--${name} 3\``;

  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return `\`--${name} ${text}\` is not a whole number — pass a count, e.g. \`--${name} 3\``;
  }
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) {
    return `\`--${name} ${text}\` is too large to record — pass a plausible count`;
  }
  return value;
}

/** Validate `--against` before any command routes off it. Null means "not given". */
function resolveAgainst(repoRoot: string, args: ParsedArgs): string | null | "invalid" {
  const ref = flagString(args, "against");
  if (ref === null) return null;

  const resolved = resolveRef(repoRoot, ref);
  if (!resolved.ok) {
    fatal(resolved.error);
    fatalDetail("nothing was routed or checked — a base ref that does not resolve has no diff to read");
    return "invalid";
  }
  return resolved.value.ref;
}

function reportUnknownCommand(name: string): number {
  const near = suggest(name, [...COMMAND_NAMES]);
  fatal(`unknown command \`keel ${name}\``);
  if (near !== null) fatalDetail(`did you mean \`keel ${near}\`?`);
  fatalDetail(`commands: ${COMMAND_NAMES.filter((c) => c !== "help").join(", ")}`);
  fatalDetail("run `keel help` for the full screen");
  return 1;
}

/** Flag and subcommand validation, shared by every command. */
function validate(args: ParsedArgs, spec: CommandSpec): number | null {
  const problems = validateFlags(args, spec);
  const badSub = validateSubcommand(args, spec);
  if (badSub !== null) problems.unshift(badSub);
  if (problems.length === 0) return null;

  for (const problem of problems) {
    fatal(problem.message);
    fatalDetail(problem.fix);
  }
  return 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), { valueFlags: valueFlagNames() });
  const repoRoot = repoRootOrCwd();
  const plugin = pluginRoot();
  setLogRoot(repoRoot);

  const spec_ = commandSpec(args.command);
  if (spec_ === null) return reportUnknownCommand(args.command);

  const invalid = validate(args, spec_);
  if (invalid !== null) return invalid;

  // `--help` works on every command, and beats running it.
  if (flagBool(args, "help")) {
    line(usage());
    return 0;
  }

  switch (args.command) {
    case "init":
      return init({
        repoRoot,
        pluginRoot: plugin,
        force: flagBool(args, "force"),
        install: !flagBool(args, "no-install"),
      });

    case "check":
      return check(repoRoot, plugin, { json: flagBool(args, "json") });

    case "doctor": {
      // `--reset-tdd` is meaningful bare (every branch) and with a value (one
      // branch), so presence — not truthiness — is what selects the reset.
      const resetTdd = flagString(args, "reset-tdd");
      return doctor(repoRoot, plugin, {
        json: flagBool(args, "json"),
        ...(flagPresent(args, "reset-tdd") ? { resetTdd: resetTdd ?? true } : {}),
      });
    }

    case "route": {
      const requested = flagString(args, "track");
      if (requested !== null && parseTrack(requested) === null) {
        fatal(`unknown track \`${requested}\` — expected quick, standard or full`);
        fatalDetail("pass one of `--track quick`, `--track standard`, `--track full`");
        return 1;
      }
      const against = resolveAgainst(repoRoot, args);
      if (against === "invalid") return 1;

      return route({
        repoRoot,
        pluginRoot: plugin,
        against,
        override: parseTrack(requested),
        json: flagBool(args, "json"),
        applyEffort: flagBool(args, "apply-effort"),
      });
    }

    case "gate": {
      const against = resolveAgainst(repoRoot, args);
      if (against === "invalid") return 1;

      return gate({
        repoRoot,
        pluginRoot: plugin,
        against,
        json: flagBool(args, "json"),
        all: flagBool(args, "all"),
        trustRepoRules: flagBool(args, "trust-repo-rules"),
      });
    }

    case "spec": {
      const requested = flagString(args, "track");
      if (requested !== null && parseTrack(requested) === null) {
        fatal(`unknown track \`${requested}\` — expected quick, standard or full`);
        return 1;
      }
      return spec({
        repoRoot,
        subcommand: args.subcommand,
        changeId: flagString(args, "change") ?? args.positional[1] ?? null,
        onDefaultBranch: flagBool(args, "default-branch"),
        track: parseTrack(requested),
        outPath: flagString(args, "out"),
        json: flagBool(args, "json"),
      });
    }

    case "mutate": {
      const against = resolveAgainst(repoRoot, args);
      if (against === "invalid") return 1;

      return mutate({
        repoRoot,
        pluginRoot: plugin,
        against,
        json: flagBool(args, "json"),
        report: flagBool(args, "report"),
      });
    }

    case "review": {
      const requested = flagString(args, "track");
      if (requested !== null && parseTrack(requested) === null) {
        fatal(`unknown track \`${requested}\` — expected quick, standard or full`);
        return 1;
      }

      if (args.subcommand === "record") {
        const track = parseTrack(requested);
        if (track === null) {
          fatal("`keel review record` needs --track quick|standard|full");
          fatalDetail("e.g. `keel review record --track standard --human-comments 4`");
          return 1;
        }

        const counts = {
          humanComments: parseCount(args, "human-comments"),
          botComments: parseCount(args, "bot-comments"),
          reviewCount: parseCount(args, "reviews"),
          changedFiles: parseCount(args, "changed-files"),
        };
        const bad = Object.values(counts).filter((v): v is string => typeof v === "string");
        if (bad.length > 0) {
          for (const message of bad) fatal(message);
          fatalDetail("nothing was recorded — the comment count is the metric this command exists for");
          return 1;
        }

        return recordReview({
          repoRoot,
          humanComments: counts.humanComments as number,
          botComments: counts.botComments as number,
          reviewCount: counts.reviewCount as number,
          changedFiles: counts.changedFiles as number,
          track,
          json: flagBool(args, "json"),
        });
      }

      const against = resolveAgainst(repoRoot, args);
      if (against === "invalid") return 1;

      return review({
        repoRoot,
        pluginRoot: plugin,
        against,
        track: parseTrack(requested),
        promptOnly: flagBool(args, "prompt"),
        json: flagBool(args, "json"),
      });
    }

    case "gotchas":
      return gotchas({
        repoRoot,
        pluginRoot: plugin,
        listOnly: flagBool(args, "list"),
        json: flagBool(args, "json"),
      });

    case "upstream":
      return upstream({
        repoRoot,
        subcommand: args.subcommand,
        dryRun: flagBool(args, "dry-run"),
        json: flagBool(args, "json"),
        approveMarketplaces: flagBool(args, "yes"),
      });

    case "trust":
      return trust({
        repoRoot,
        pluginRoot: plugin,
        subcommand: args.subcommand,
        pack: args.positional[1] ?? null,
        json: flagBool(args, "json"),
        all: flagBool(args, "all"),
      });

    case "telemetry":
      return telemetry(repoRoot, args.subcommand, flagString(args, "to"), {
        json: flagBool(args, "json"),
      });

    case "version":
      line(PLUGIN_VERSION);
      return 0;

    case "help":
      // `keel --version` resolves to the version command in parseArgs; this
      // catches `keel help --version`.
      if (flagPresent(args, "version")) {
        line(PLUGIN_VERSION);
        return 0;
      }
      line(usage());
      return 0;

    default:
      return reportUnknownCommand(args.command);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    fatal(errorMessage(cause));
    process.exitCode = 1;
  });
