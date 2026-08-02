/**
 * A small, explicit argument parser.
 *
 * Hand-rolled rather than pulled from npm: the CLI is bundled into a hook-sized
 * artifact, the surface is a dozen commands, and a dependency here would be paid
 * for on every cold start.
 *
 * The parser knows which flags take a value (`valueFlags`). Without that, a
 * boolean flag swallowed the next word — `keel spec --json check` set
 * `json="check"` and lost the subcommand — and an unknown flag was accepted in
 * silence, so `keel route --trak full` exited 0 having ignored the typo.
 * Validation against a per-command flag list is what closes the second half.
 */

export interface ParsedArgs {
  readonly command: string;
  readonly subcommand: string | null;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly positional: readonly string[];
  /** How the user spelled each flag, for error messages: `--trak`, `-x`. */
  readonly spelling: Readonly<Record<string, string>>;
  /** True when no command word was given at all (`keel`, `keel --version`). */
  readonly implicitCommand: boolean;
}

/** Short flags Keel understands, and the long flag each one means. */
export const SHORT_ALIASES: Readonly<Record<string, string>> = {
  h: "help",
  v: "version",
  V: "version",
};

export interface ParseOptions {
  /** Flag names that consume the following token as their value. */
  readonly valueFlags?: ReadonlySet<string>;
}

export function parseArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = options.valueFlags ?? new Set<string>();
  const flags: Record<string, string | boolean> = {};
  const spelling: Record<string, string> = {};
  const positional: string[] = [];

  const remember = (name: string, token: string): void => {
    if (spelling[name] === undefined) spelling[name] = token;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";

    if (arg === "--") {
      // Everything after `--` is positional, verbatim.
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        const name = body.slice(0, eq);
        flags[name] = body.slice(eq + 1);
        remember(name, `--${name}`);
        continue;
      }

      const next = argv[i + 1];
      // Only a flag declared as taking a value consumes the next token.
      if (valueFlags.has(body) && next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      remember(body, `--${body}`);
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) {
        const name = SHORT_ALIASES[ch] ?? ch;
        flags[name] = true;
        remember(name, `-${ch}`);
      }
      continue;
    }

    positional.push(arg);
  }

  const explicit = positional[0];
  let command = explicit ?? "help";
  if (explicit === undefined) {
    // `keel --version` / `keel -v` used to fall through to the usage screen,
    // because the flag never became a command.
    if (flags["version"] === true) command = "version";
    else command = "help";
  }

  return {
    command,
    subcommand: positional[1] ?? null,
    flags,
    positional: positional.slice(1),
    spelling,
    implicitCommand: explicit === undefined,
  };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/** True when the flag was given at all, whatever its value. */
export function flagPresent(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

// ---------------------------------------------------------------------------
// Did-you-mean
// ---------------------------------------------------------------------------

/** Levenshtein distance, iterative and allocation-light. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The closest candidate to `input`, or null when nothing is close enough.
 *
 * A suggestion that is wrong is worse than none: it sends someone to re-run a
 * command they did not mean. The threshold scales with length so `rout` finds
 * `route` while `xyz` finds nothing.
 */
export function suggest(input: string, candidates: readonly string[]): string | null {
  const needle = input.toLowerCase();
  const limit = needle.length <= 3 ? 1 : needle.length <= 6 ? 2 : 3;

  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const other = candidate.toLowerCase();
    // A prefix or containment match beats edit distance: `--human` -> `--human-comments`.
    const score = other.startsWith(needle) || needle.startsWith(other)
      ? 0
      : editDistance(needle, other);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore <= limit ? best : null;
}
