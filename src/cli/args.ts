/**
 * A small, explicit argument parser.
 *
 * Hand-rolled rather than pulled from npm: the CLI is bundled into a hook-sized
 * artifact, the surface is six commands, and a dependency here would be paid
 * for on every cold start.
 */

export interface ParsedArgs {
  readonly command: string;
  readonly subcommand: string | null;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly positional: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      // `--flag value`, but `--flag --other` leaves --flag boolean.
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
      continue;
    }

    positional.push(arg);
  }

  return {
    command: positional[0] ?? "help",
    subcommand: positional[1] ?? null,
    flags,
    positional: positional.slice(1),
  };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}
