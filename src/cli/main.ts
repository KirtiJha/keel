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
import { mutate } from "./commands/mutate.js";
import { recordReview, review } from "./commands/review.js";
import { route } from "./commands/route.js";
import { spec } from "./commands/spec.js";
import { telemetry } from "./commands/telemetry.js";
import { upstream } from "./commands/upstream.js";
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
  spec [check|delta|new|onboard|list]
                       full-track spec discipline: size cap, delta, archive gate
  mutate               diff-only mutation testing, gated on score
  review [record]      assemble the review chain's input
  upstream [status|install]
                       verify or install the pinned upstream set
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
  --change <id>        which change to act on (spec delta)
  --out <path>         write output to a file instead of stdout (spec delta)
  --default-branch     treat this run as the default branch (spec check, CI)
  --report             report without failing (mutate)
  --prompt             emit only the assembled prompt (review)
  --apply-effort       write the track's effort to settings.local.json (route)
  --no-install         skip installing the upstream set (init)
  --dry-run            show what would run without running it (upstream install)

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
      return init({
        repoRoot,
        pluginRoot: plugin,
        force: flagBool(args, "force"),
        install: !flagBool(args, "no-install"),
      });

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
        applyEffort: flagBool(args, "apply-effort"),
      });
    }

    case "spec": {
      const requested = flagString(args, "track");
      if (requested !== null && parseTrack(requested) === null) {
        fail(`unknown track \`${requested}\` — expected quick, standard or full`);
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

    case "mutate":
      return mutate({
        repoRoot,
        pluginRoot: plugin,
        against: flagString(args, "against"),
        json: flagBool(args, "json"),
        report: flagBool(args, "report"),
      });

    case "review": {
      const requested = flagString(args, "track");
      if (requested !== null && parseTrack(requested) === null) {
        fail(`unknown track \`${requested}\` — expected quick, standard or full`);
        return 1;
      }

      if (args.subcommand === "record") {
        const track = parseTrack(requested);
        if (track === null) {
          fail("`keel review record` needs --track quick|standard|full");
          return 1;
        }
        return recordReview({
          repoRoot,
          humanComments: Number.parseInt(flagString(args, "human-comments") ?? "0", 10) || 0,
          botComments: Number.parseInt(flagString(args, "bot-comments") ?? "0", 10) || 0,
          reviewCount: Number.parseInt(flagString(args, "reviews") ?? "0", 10) || 0,
          changedFiles: Number.parseInt(flagString(args, "changed-files") ?? "0", 10) || 0,
          track,
        });
      }

      return review({
        repoRoot,
        pluginRoot: plugin,
        against: flagString(args, "against"),
        track: parseTrack(requested),
        promptOnly: flagBool(args, "prompt"),
      });
    }

    case "gotchas":
      return gotchas({
        repoRoot,
        pluginRoot: plugin,
        listOnly: flagBool(args, "list"),
      });

    case "upstream":
      return upstream({
        repoRoot,
        subcommand: args.subcommand,
        dryRun: flagBool(args, "dry-run"),
        json: flagBool(args, "json"),
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
