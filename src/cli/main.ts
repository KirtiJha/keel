import { PLUGIN_VERSION } from "../telemetry/spool.js";
import { repoRootOrCwd } from "../shared/paths.js";
import { setLogRoot } from "../shared/log.js";
import { errorMessage } from "../shared/result.js";
import { pluginRoot } from "../hooks/context.js";
import type { Track } from "../shared/config.js";

import { flagBool, flagString, parseArgs } from "./args.js";
import { check } from "./commands/check.js";
import { doctor } from "./commands/doctor.js";
import { gotchas } from "./commands/gotchas.js";
import { init } from "./commands/init.js";
import { route } from "./commands/route.js";
import { telemetry } from "./commands/telemetry.js";
import { bold, dim, fail, line } from "./output.js";

const USAGE = `
${bold("keel")} — spec-driven development for Claude Code

${bold("Usage")}
  keel <command> [options]

${bold("Commands")}
  init                 set this repository up (idempotent)
  check                validate config, packs, phase ownership and pins
  doctor               what is active, and how fast it runs
  route                classify the current change and pick a track
  gotchas              review and confirm gotcha candidates
  telemetry [show|ship|clear]
  version              print the plugin version

${bold("Options")}
  --against <ref>      route against a base ref instead of the working tree
  --track <name>       override the routed track (quick|standard|full)
  --json               machine-readable output where supported
  --list               list only, do not prompt (gotchas)
  --force              overwrite instead of keeping (init)
  --to <path>          destination directory (telemetry ship)

${dim("Docs: README.md")}
`;

function parseTrack(value: string | null): Track | null {
  if (value === "quick" || value === "standard" || value === "full") return value;
  return null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = repoRootOrCwd();
  const plugin = pluginRoot();
  setLogRoot(repoRoot);

  switch (args.command) {
    case "init":
      return init({ repoRoot, pluginRoot: plugin, force: flagBool(args, "force") });

    case "check":
      return check(repoRoot, plugin);

    case "doctor":
      return doctor(repoRoot, plugin);

    case "route": {
      const requested = flagString(args, "track");
      if (requested !== null && parseTrack(requested) === null) {
        fail(`unknown track \`${requested}\` — expected quick, standard or full`);
        return 1;
      }
      return route({
        repoRoot,
        pluginRoot: plugin,
        against: flagString(args, "against"),
        override: parseTrack(requested),
        json: flagBool(args, "json"),
      });
    }

    case "gotchas":
      return gotchas({
        repoRoot,
        pluginRoot: plugin,
        listOnly: flagBool(args, "list"),
      });

    case "telemetry":
      return telemetry(repoRoot, args.subcommand, flagString(args, "to"));

    case "version":
    case "--version":
      line(PLUGIN_VERSION);
      return 0;

    case "help":
    case "--help":
      line(USAGE);
      return 0;

    default:
      fail(`unknown command \`${args.command}\``);
      line(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    fail(errorMessage(cause));
    process.exitCode = 1;
  });
