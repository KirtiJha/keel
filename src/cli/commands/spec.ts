import { writeFileSync } from "node:fs";

import { loadConfigOrDefaults, type Track } from "../../shared/config.js";
import { currentBranch, isGitRepo } from "../../shared/git.js";
import { checkSpecs } from "../../spec/check.js";
import { deltaFor, renderDelta } from "../../spec/delta.js";
import { activeProposals, discoverProposals, proposalForBranch } from "../../spec/discover.js";
import { onboardInstructions, scaffoldChange } from "../../spec/scaffold.js";
import { bold, detail, dim, fail, heading, info, line, ok, rows, warn } from "../output.js";

/**
 * `keel spec <check|delta|new|onboard|list>` — the Full-track spec discipline.
 */

export interface SpecOptions {
  readonly repoRoot: string;
  readonly subcommand: string | null;
  readonly changeId: string | null;
  /** Treat this run as being on the default branch (CI passes it explicitly). */
  readonly onDefaultBranch: boolean;
  readonly track: Track | null;
  /** Write the rendered delta here instead of stdout. */
  readonly outPath: string | null;
  readonly json: boolean;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk"]);

export function spec(options: SpecOptions): number {
  const { config } = loadConfigOrDefaults(options.repoRoot);
  const onDefault =
    options.onDefaultBranch ||
    (isGitRepo(options.repoRoot) && DEFAULT_BRANCHES.has(currentBranch(options.repoRoot)));

  switch (options.subcommand) {
    case "check":
    case null:
      return specCheck(options, config, onDefault);
    case "delta":
      return specDelta(options, config);
    case "new":
      return specNew(options, config);
    case "onboard":
      return specOnboard(options, config);
    case "list":
      return specList(options, config);
    default:
      fail(`unknown subcommand \`${options.subcommand}\` — expected check, delta, new, onboard or list`);
      return 1;
  }
}

function specCheck(
  options: SpecOptions,
  config: ReturnType<typeof loadConfigOrDefaults>["config"],
  onDefault: boolean,
): number {
  const result = checkSpecs({
    root: options.repoRoot,
    config,
    onDefaultBranch: onDefault,
    ...(options.track === null ? {} : { track: options.track }),
  });

  if (options.json) {
    line(JSON.stringify({ errors: result.errors, warnings: result.warnings, issues: result.issues }));
    return result.errors > 0 ? 1 : 0;
  }

  heading("Spec discipline");
  rows([
    ["spec dir", config.spec.dir],
    ["size cap", `${config.spec.max_lines} lines per change`],
    ["EARS", config.spec.ears ? "on (trial)" : dim("off")],
    ["branch", onDefault ? "default (archive gate active)" : "feature"],
  ]);

  const active = result.proposals.filter((p) => !p.archived);
  heading("Changes");
  if (result.proposals.length === 0) {
    info(`no changes under ${config.spec.dir}/changes/`);
  } else {
    rows(
      result.proposals.map((p) => [
        p.id,
        `${p.archived ? "archived" : p.status.padEnd(11)} ${String(p.lineCount).padStart(4)} lines`,
      ]),
    );
  }

  if (result.issues.length > 0) {
    heading("Issues");
    for (const issue of result.issues) {
      const render = issue.severity === "error" ? fail : warn;
      render(`[${issue.rule}] ${issue.change}: ${issue.message}`);
      detail(`fix: ${issue.fix}`);
    }
  }

  heading("Summary");
  if (result.errors === 0 && result.warnings === 0) {
    ok(`${active.length} active change${active.length === 1 ? "" : "s"}, no issues`);
    line();
    return 0;
  }
  if (result.errors === 0) {
    warn(`${result.warnings} warning${result.warnings === 1 ? "" : "s"}, no errors`);
    line();
    return 0;
  }
  fail(`${result.errors} error${result.errors === 1 ? "" : "s"}, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}`);
  line();
  return 1;
}

function specDelta(
  options: SpecOptions,
  config: ReturnType<typeof loadConfigOrDefaults>["config"],
): number {
  const branch = isGitRepo(options.repoRoot) ? currentBranch(options.repoRoot) : "";
  const proposal =
    options.changeId !== null
      ? (discoverProposals(options.repoRoot, config).find((p) => p.id === options.changeId) ?? null)
      : proposalForBranch(options.repoRoot, config, branch);

  if (proposal === null) {
    const active = activeProposals(options.repoRoot, config);
    fail(
      options.changeId === null
        ? `could not identify the change for branch \`${branch}\``
        : `no change named \`${options.changeId}\``,
    );
    if (active.length > 0) {
      detail(`active changes: ${active.map((p) => p.id).join(", ")}`);
      detail("pass one explicitly: `keel spec delta --change <id>`");
    } else {
      detail(`no changes found under ${config.spec.dir}/changes/`);
    }
    return 1;
  }

  const rendered = renderDelta(proposal, deltaFor(options.repoRoot, proposal), {
    withMarkers: true,
  });

  if (options.outPath !== null) {
    try {
      writeFileSync(options.outPath, `${rendered}\n`, "utf8");
    } catch (cause) {
      fail(`could not write ${options.outPath}: ${String(cause)}`);
      return 1;
    }
    ok(`wrote the delta for \`${proposal.id}\` to ${options.outPath}`);
    return 0;
  }

  // Plain stdout so CI can pipe it straight into a PR comment.
  process.stdout.write(`${rendered}\n`);
  return 0;
}

function specNew(
  options: SpecOptions,
  config: ReturnType<typeof loadConfigOrDefaults>["config"],
): number {
  if (options.changeId === null) {
    fail("usage: keel spec new <change-id>");
    return 1;
  }

  const result = scaffoldChange(options.repoRoot, config, options.changeId);
  if (!result.ok) {
    fail(result.error);
    return 1;
  }

  heading("New change");
  ok(`scaffolded ${result.value.dir}`);
  info("structure only — OpenSpec owns the design phase, and the content is yours");
  line();
  line(`  ${bold("next")}  fill in Why and What changes, then mark the delta under`);
  line("        ADDED / MODIFIED / REMOVED so reviewers can read it");
  if (result.value.openspec) {
    line("        OpenSpec is installed — its commands drive from here");
  }
  line();
  return 0;
}

function specOnboard(
  options: SpecOptions,
  config: ReturnType<typeof loadConfigOrDefaults>["config"],
): number {
  heading("Brownfield onboarding");
  for (const text of onboardInstructions(options.repoRoot, config)) line(`  ${text}`);
  line();
  return 0;
}

function specList(
  options: SpecOptions,
  config: ReturnType<typeof loadConfigOrDefaults>["config"],
): number {
  const proposals = discoverProposals(options.repoRoot, config);

  if (options.json) {
    line(JSON.stringify(proposals.map((p) => ({ ...p, files: p.files.length }))));
    return 0;
  }

  heading("Changes");
  if (proposals.length === 0) {
    info(`none under ${config.spec.dir}/changes/`);
    line();
    return 0;
  }

  rows(
    proposals.map((p) => [
      p.id,
      `${(p.archived ? "archived" : p.status).padEnd(12)}${String(p.lineCount).padStart(4)} lines  ${dim(p.relDir)}`,
    ]),
  );
  line();
  return 0;
}
