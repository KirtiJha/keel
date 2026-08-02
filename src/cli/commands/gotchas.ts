import { createInterface } from "node:readline/promises";

import { loadConfigOrDefaults } from "../../shared/config.js";
import { writeClaudeMd } from "../../context/claudemd.js";
import { scanGotchas, type GotchaCandidate } from "../../context/gotchas.js";
import { loadPacks } from "../../standards/loader.js";
import { bold, detail, dim, heading, info, json, line, ok, warn } from "../output.js";

/**
 * `keel gotchas` — review candidates and confirm them one at a time.
 *
 * M5 requires human confirmation for every gotcha before it is written. This is
 * that step, and it is the only path by which a gotcha reaches CLAUDE.md: the
 * scanner proposes, a person decides.
 */

export interface GotchaOptions {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  /** Print candidates and exit without prompting. */
  readonly listOnly?: boolean;
  readonly json?: boolean;
  /** Non-interactive input, used by tests. */
  readonly answers?: readonly string[];
  /** Override TTY detection, used by tests. */
  readonly interactive?: boolean;
}

function render(candidate: GotchaCandidate, index: number, total: number): void {
  line();
  line(`  ${bold(`[${index + 1}/${total}]`)} ${candidate.path}${candidate.line === undefined ? "" : `:${candidate.line}`}  ${dim(`(${candidate.kind}, ${candidate.confidence} confidence)`)}`);
  line(`  ${dim("evidence")}  ${candidate.evidence}`);
  line(`  ${dim("proposed")}  ${candidate.proposed}`);
}

export async function gotchas(options: GotchaOptions): Promise<number> {
  const { config } = loadConfigOrDefaults(options.repoRoot);
  const candidates = scanGotchas(options.repoRoot, { max: 25 });

  if (options.json === true) {
    json({
      candidates: candidates.map((c) => ({
        path: c.path,
        ...(c.line === undefined ? {} : { line: c.line }),
        kind: c.kind,
        confidence: c.confidence,
        evidence: c.evidence,
        proposed: c.proposed,
      })),
      written: 0,
      note: "candidates only — confirmation is interactive and writes nothing without a terminal",
    });
    return 0;
  }

  /**
   * Confirmation needs somewhere to read an answer from.
   *
   * Under a pipe or in CI, `readline` resolved every question against a closed
   * stdin: a prompt or two appeared, nothing was written, and the command
   * exited 0 with no summary — an invisible no-op in exactly the place people
   * automate it. Non-TTY now behaves as `--list` and says why.
   */
  const scripted = options.answers;
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  const listOnly = options.listOnly === true || (scripted === undefined && !interactive);

  heading("Gotcha candidates");

  if (candidates.length === 0) {
    info("none found");
    line();
    return 0;
  }

  line(
    `  ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}. Nothing is written unless you confirm it.`,
  );

  if (listOnly) {
    candidates.forEach((c, i) => render(c, i, candidates.length));
    line();
    if (options.listOnly !== true) {
      heading("Result");
      warn("stdin is not a terminal, so nothing was confirmed and nothing was written");
      detail(
        "fix: run `keel gotchas` in a terminal to confirm them one at a time, or keep using `keel gotchas --list` (or `--json`) for a read-only listing in CI",
      );
      line();
    }
    return 0;
  }

  const confirmed: GotchaCandidate[] = [];

  const rl = scripted === undefined
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (candidate === undefined) continue;
      render(candidate, i, candidates.length);

      const answer = scripted === undefined
        ? ((await rl?.question("  keep this gotcha? [y/N/q] ")) ?? "n")
        : (scripted[i] ?? "n");

      const normalised = answer.trim().toLowerCase();
      if (normalised === "q") break;
      if (normalised === "y" || normalised === "yes") confirmed.push(candidate);
    }
  } finally {
    rl?.close();
  }

  heading("Result");
  if (confirmed.length === 0) {
    info("nothing confirmed — CLAUDE.md unchanged");
    line();
    return 0;
  }

  const guidePacks = loadPacks(options.repoRoot, options.pluginRoot, config)
    .packs.filter((p) => p.standard.mode === "guide")
    .map((p) => p.standard.name);

  const result = writeClaudeMd({
    root: options.repoRoot,
    config,
    confirmedGotchas: confirmed,
    guidePacks,
  });

  ok(`${confirmed.length} gotcha${confirmed.length === 1 ? "" : "s"} written — CLAUDE.md ${result.action}`);
  line();
  return 0;
}
