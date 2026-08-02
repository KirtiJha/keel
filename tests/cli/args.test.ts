import { describe, expect, it } from "vitest";

import { editDistance, flagBool, flagString, parseArgs, suggest } from "../../src/cli/args.js";
import {
  COMMANDS,
  COMMAND_NAMES,
  commandSpec,
  validateFlags,
  validateSubcommand,
  valueFlagNames,
} from "../../src/cli/registry.js";

const VALUE_FLAGS = valueFlagNames();
const parse = (argv: readonly string[]) => parseArgs(argv, { valueFlags: VALUE_FLAGS });

describe("command resolution", () => {
  it("treats --version as the version command", () => {
    // `case "--version"` in main was unreachable: the flag never became a
    // command, so `positional[0]` was undefined and help ran instead.
    expect(parse(["--version"]).command).toBe("version");
  });

  it("treats -v and -V as the version command", () => {
    expect(parse(["-v"]).command).toBe("version");
    expect(parse(["-V"]).command).toBe("version");
  });

  it("treats --help and -h as help", () => {
    expect(parse(["--help"]).command).toBe("help");
    expect(parse(["-h"]).command).toBe("help");
  });

  it("defaults to help with no arguments at all", () => {
    expect(parse([]).command).toBe("help");
  });

  it("keeps an explicit command ahead of a flag", () => {
    expect(parse(["route", "--version"]).command).toBe("route");
  });
});

describe("value flags", () => {
  it("consumes the next token for a flag declared as taking a value", () => {
    expect(flagString(parse(["route", "--against", "main"]), "against")).toBe("main");
  });

  it("accepts --flag=value", () => {
    expect(flagString(parse(["route", "--against=main"]), "against")).toBe("main");
  });

  it("does not let a switch swallow the following word", () => {
    // `keel spec --json check` used to set json="check" and lose the subcommand.
    const args = parse(["spec", "--json", "check"]);
    expect(flagBool(args, "json")).toBe(true);
    expect(args.subcommand).toBe("check");
  });

  it("leaves a value flag boolean when nothing follows it", () => {
    expect(parse(["route", "--against"]).flags["against"]).toBe(true);
  });

  it("records how each flag was typed, for the error message", () => {
    expect(parse(["route", "--trak", "full"]).spelling["trak"]).toBe("--trak");
    expect(parse(["route", "-x"]).spelling["x"]).toBe("-x");
  });

  it("passes everything after -- through as positional", () => {
    expect(parse(["spec", "new", "--", "--not-a-flag"]).positional).toEqual([
      "new",
      "--not-a-flag",
    ]);
  });
});

describe("flag validation", () => {
  const route = commandSpec("route");
  if (route === null) throw new Error("route command is missing from the registry");

  it("rejects an unknown flag and names it as typed", () => {
    const problems = validateFlags(parse(["route", "--trak", "full"]), route);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("--trak");
    expect(problems[0]?.message).toContain("keel route");
  });

  it("suggests the near miss", () => {
    const problems = validateFlags(parse(["route", "--trak", "full"]), route);
    expect(problems[0]?.fix).toContain("--track");
  });

  it("lists the valid flags when there is no near miss", () => {
    const problems = validateFlags(parse(["route", "--wibble"]), route);
    expect(problems[0]?.fix).toContain("--against");
    expect(problems[0]?.fix).toContain("--json");
  });

  it("reports every unknown flag, not just the first", () => {
    const check = commandSpec("check");
    if (check === null) throw new Error("check command is missing");
    const problems = validateFlags(parse(["check", "--wibble", "--explode=yes"]), check);
    expect(problems).toHaveLength(2);
  });

  it("rejects a value flag given with no value", () => {
    const problems = validateFlags(parse(["route", "--against"]), route);
    expect(problems[0]?.message).toContain("needs a value");
    expect(problems[0]?.fix).toContain("<ref>");
  });

  it("rejects a value flag given an empty value", () => {
    const problems = validateFlags(parse(["route", "--against="]), route);
    expect(problems[0]?.message).toContain("empty value");
  });

  it("rejects a value handed to a switch", () => {
    const problems = validateFlags(parse(["route", "--json=maybe"]), route);
    expect(problems[0]?.message).toContain("takes no value");
  });

  it("accepts an explicit true/false on a switch", () => {
    expect(validateFlags(parse(["route", "--json=false"]), route)).toEqual([]);
  });

  it("accepts --help everywhere", () => {
    for (const spec of COMMANDS) {
      expect(validateFlags(parse([spec.name, "--help"]), spec), spec.name).toEqual([]);
    }
  });
});

describe("subcommand validation", () => {
  it("suggests a near-miss subcommand", () => {
    const spec = commandSpec("upstream");
    if (spec === null) throw new Error("upstream command is missing");
    const problem = validateSubcommand(parse(["upstream", "instal"]), spec);
    expect(problem?.message).toContain("instal");
    expect(problem?.fix).toContain("keel upstream install");
  });

  it("accepts a command with no subcommand given", () => {
    const spec = commandSpec("upstream");
    if (spec === null) throw new Error("upstream command is missing");
    expect(validateSubcommand(parse(["upstream"]), spec)).toBeNull();
  });

  it("rejects stray arguments to a command that takes none", () => {
    const spec = commandSpec("doctor");
    if (spec === null) throw new Error("doctor command is missing");
    expect(validateSubcommand(parse(["doctor", "everything"]), spec)?.message).toContain(
      "takes no arguments",
    );
  });
});

describe("suggestions", () => {
  it("measures edit distance", () => {
    expect(editDistance("rout", "route")).toBe(1);
    expect(editDistance("same", "same")).toBe(0);
  });

  it("finds the near miss for a mistyped command", () => {
    expect(suggest("rout", [...COMMAND_NAMES])).toBe("route");
    expect(suggest("doctr", [...COMMAND_NAMES])).toBe("doctor");
    expect(suggest("chek", [...COMMAND_NAMES])).toBe("check");
  });

  it("says nothing rather than guessing wildly", () => {
    expect(suggest("zzzzzzzzzz", [...COMMAND_NAMES])).toBeNull();
  });
});

describe("registry invariants", () => {
  it("gives every flag the same kind wherever it appears", () => {
    // The parser must decide whether a flag takes a value before it knows which
    // command is running, so a name cannot mean two different things.
    const kinds = new Map<string, string>();
    for (const command of COMMANDS) {
      for (const flag of command.flags) {
        const seen = kinds.get(flag.name);
        expect(seen === undefined || seen === flag.kind, `${flag.name} in ${command.name}`).toBe(
          true,
        );
        kinds.set(flag.name, flag.kind);
      }
    }
  });

  it("documents every flag it accepts", () => {
    for (const command of COMMANDS) {
      for (const flag of command.flags) {
        expect(flag.help.length, `${command.name} --${flag.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("declares the counters `review record` reads", () => {
    const review = commandSpec("review");
    const names = review?.flags.map((f) => f.name) ?? [];
    for (const flag of ["human-comments", "bot-comments", "reviews", "changed-files"]) {
      expect(names, flag).toContain(flag);
    }
  });
});
