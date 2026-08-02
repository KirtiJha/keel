import { type ParsedArgs, suggest } from "./args.js";

/**
 * The command and flag surface, declared once.
 *
 * Two defects came from this not existing. Unknown flags were accepted in
 * silence — `keel route --trak full` exited 0 having ignored the typo, so a
 * developer believed they had overridden the track and had not. And `--help`
 * drifted out of date, omitting four flags `review record` actually reads.
 * Both are structural: the usage screen is now *rendered from this table*, and
 * every flag is checked against it, so neither can come back.
 */

export type FlagKind = "boolean" | "string";

export interface FlagSpec {
  readonly name: string;
  readonly kind: FlagKind;
  /** Metavariable shown in help for a value flag, e.g. `<ref>`. */
  readonly value?: string;
  readonly help: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  /** Extra usage lines printed under the command in the help screen. */
  readonly usage?: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly FlagSpec[];
  /** True when bare words after the command are meaningful (`spec new <id>`). */
  readonly takesPositional?: boolean;
}

const AGAINST: FlagSpec = {
  name: "against",
  kind: "string",
  value: "<ref>",
  help: "compare against a base ref instead of the working tree",
};
const JSON_FLAG: FlagSpec = { name: "json", kind: "boolean", help: "machine-readable output" };
const TRACK: FlagSpec = {
  name: "track",
  kind: "string",
  value: "<name>",
  help: "override the routed track (quick|standard|full)",
};

/** Accepted everywhere, so `keel <anything> --help` works. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "help", kind: "boolean", help: "show this help (-h)" },
];

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    summary: "set this repository up (idempotent)",
    subcommands: [],
    flags: [
      { name: "force", kind: "boolean", help: "overwrite instead of keeping" },
      {
        name: "no-install",
        kind: "boolean",
        help: "skip the upstream install *check* (init never installs)",
      },
    ],
  },
  {
    name: "check",
    summary: "validate config, packs, phase ownership and pins",
    subcommands: [],
    flags: [JSON_FLAG],
  },
  {
    name: "doctor",
    summary: "what is active, and how fast it runs",
    subcommands: [],
    flags: [JSON_FLAG],
  },
  {
    name: "route",
    summary: "classify the current change and pick a track",
    subcommands: [],
    flags: [
      AGAINST,
      TRACK,
      JSON_FLAG,
      {
        name: "apply-effort",
        kind: "boolean",
        help: "write the track's effort to settings.local.json",
      },
    ],
  },
  {
    name: "gate",
    summary: "run the standards gates over the changed files (CI-safe)",
    subcommands: [],
    flags: [
      AGAINST,
      JSON_FLAG,
      {
        name: "all",
        kind: "boolean",
        help: "hold nothing back: advisory findings (gate), every untrusted pack (trust add)",
      },
    ],
  },
  {
    name: "spec",
    summary: "full-track spec discipline: size cap, delta, archive gate",
    usage: "keel spec [check|delta|new <id>|onboard|list]",
    subcommands: ["check", "delta", "new", "onboard", "list"],
    takesPositional: true,
    flags: [
      { name: "change", kind: "string", value: "<id>", help: "which change to act on" },
      { name: "out", kind: "string", value: "<path>", help: "write output to a file, not stdout" },
      {
        name: "default-branch",
        kind: "boolean",
        help: "treat this run as the default branch (CI)",
      },
      TRACK,
      JSON_FLAG,
    ],
  },
  {
    name: "mutate",
    summary: "diff-only mutation testing, gated on score",
    subcommands: [],
    flags: [
      AGAINST,
      JSON_FLAG,
      { name: "report", kind: "boolean", help: "report without failing" },
    ],
  },
  {
    name: "review",
    summary: "assemble the review chain's input",
    usage: "keel review [record]",
    subcommands: ["record"],
    flags: [
      AGAINST,
      TRACK,
      JSON_FLAG,
      { name: "prompt", kind: "boolean", help: "emit only the assembled prompt, diff included" },
      {
        name: "human-comments",
        kind: "string",
        value: "<n>",
        help: "human PR comments to record (`review record`)",
      },
      {
        name: "bot-comments",
        kind: "string",
        value: "<n>",
        help: "bot PR comments to record (`review record`)",
      },
      {
        name: "reviews",
        kind: "string",
        value: "<n>",
        help: "review count to record (`review record`)",
      },
      {
        name: "changed-files",
        kind: "string",
        value: "<n>",
        help: "changed-file count to record (`review record`)",
      },
    ],
  },
  {
    name: "upstream",
    summary: "verify or install the pinned upstream set",
    usage: "keel upstream [status|install]",
    subcommands: ["status", "install"],
    flags: [
      JSON_FLAG,
      { name: "dry-run", kind: "boolean", help: "show what would run without running it" },
      {
        name: "yes",
        kind: "boolean",
        help: "approve declaring the lock's marketplaces in .claude/settings.json",
      },
    ],
  },
  {
    name: "trust",
    summary: "review and approve repo-local standards pack rules before they run",
    usage: "keel trust [list|add <pack>|remove <pack>]",
    subcommands: ["list", "add", "remove"],
    takesPositional: true,
    flags: [
      JSON_FLAG,
      {
        name: "all",
        kind: "boolean",
        help: "hold nothing back: advisory findings (gate), every untrusted pack (trust add)",
      },
    ],
  },
  {
    name: "gotchas",
    summary: "review and confirm gotcha candidates",
    subcommands: [],
    flags: [
      JSON_FLAG,
      { name: "list", kind: "boolean", help: "list only, do not prompt" },
    ],
  },
  {
    name: "telemetry",
    summary: "local telemetry: what ran, how often, how fast",
    usage: "keel telemetry [show|ship|clear]",
    subcommands: ["show", "ship", "clear"],
    flags: [
      JSON_FLAG,
      { name: "to", kind: "string", value: "<path>", help: "destination directory for `telemetry ship`" },
    ],
  },
  {
    name: "version",
    summary: "print the plugin version",
    subcommands: [],
    takesPositional: true,
    flags: [{ name: "version", kind: "boolean", help: "print the plugin version (-v)" }],
  },
  {
    name: "help",
    summary: "print this screen",
    subcommands: [],
    takesPositional: true,
    flags: [{ name: "version", kind: "boolean", help: "print the plugin version (-v)" }],
  },
];

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

export function commandSpec(name: string): CommandSpec | null {
  return COMMANDS.find((c) => c.name === name) ?? null;
}

/**
 * Every flag name that takes a value, across all commands.
 *
 * The parser needs this before it knows which command is running, which is why
 * a name must mean the same thing everywhere. `assertFlagKindsAgree` in the
 * tests holds that invariant.
 */
export function valueFlagNames(): Set<string> {
  const out = new Set<string>();
  for (const command of COMMANDS) {
    for (const flag of [...command.flags, ...GLOBAL_FLAGS]) {
      if (flag.kind === "string") out.add(flag.name);
    }
  }
  return out;
}

export interface FlagProblem {
  readonly message: string;
  readonly fix: string;
}

function flagList(spec: CommandSpec): string {
  return [...spec.flags, ...GLOBAL_FLAGS]
    .map((f) => `--${f.name}${f.value === undefined ? "" : ` ${f.value}`}`)
    .sort()
    .join("  ");
}

/**
 * Reject flags this command does not accept, and values that do not fit.
 *
 * Every message names the flag as the user typed it, lists what the command
 * does accept, and suggests the near miss when there is one.
 */
export function validateFlags(args: ParsedArgs, spec: CommandSpec): FlagProblem[] {
  const allowed = new Map<string, FlagSpec>();
  for (const flag of [...spec.flags, ...GLOBAL_FLAGS]) allowed.set(flag.name, flag);

  const problems: FlagProblem[] = [];
  const names = [...allowed.keys()];

  for (const [name, value] of Object.entries(args.flags)) {
    const typed = args.spelling[name] ?? `--${name}`;
    const known = allowed.get(name);

    if (known === undefined) {
      const near = suggest(name, names);
      problems.push({
        message: `unknown flag \`${typed}\` for \`keel ${spec.name}\``,
        fix:
          near === null
            ? `\`keel ${spec.name}\` accepts: ${flagList(spec)}`
            : `did you mean \`--${near}\`? \`keel ${spec.name}\` accepts: ${flagList(spec)}`,
      });
      continue;
    }

    if (known.kind === "string") {
      if (value === true) {
        problems.push({
          message: `\`${typed}\` needs a value`,
          fix: `pass one, e.g. \`${typed} ${known.value ?? "<value>"}\``,
        });
      } else if (value === "") {
        problems.push({
          message: `\`${typed}\` was given an empty value`,
          fix: `pass a real one, e.g. \`${typed} ${known.value ?? "<value>"}\``,
        });
      }
      continue;
    }

    // Boolean flags accept bare use or an explicit true/false, nothing else.
    if (typeof value === "string" && value !== "true" && value !== "false") {
      problems.push({
        message: `\`${typed}\` is a switch and takes no value (got \`${value}\`)`,
        fix: `drop the value: \`${typed}\``,
      });
    }
  }

  return problems;
}

/** Reject a subcommand this command does not have, with a suggestion. */
export function validateSubcommand(args: ParsedArgs, spec: CommandSpec): FlagProblem | null {
  if (spec.subcommands.length === 0) {
    if (!(spec.takesPositional ?? false) && args.positional.length > 0) {
      return {
        message: `\`keel ${spec.name}\` takes no arguments (got \`${args.positional.join(" ")}\`)`,
        fix: `run \`keel ${spec.name}\` on its own`,
      };
    }
    return null;
  }

  const sub = args.subcommand;
  if (sub === null || spec.subcommands.includes(sub)) return null;

  const near = suggest(sub, spec.subcommands);
  return {
    message: `unknown subcommand \`${sub}\` for \`keel ${spec.name}\``,
    fix:
      near === null
        ? `expected one of: ${spec.subcommands.join(", ")}`
        : `did you mean \`keel ${spec.name} ${near}\`? expected one of: ${spec.subcommands.join(", ")}`,
  };
}
