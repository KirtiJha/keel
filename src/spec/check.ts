import type { KeelConfig, Track } from "../shared/config.js";

import { deltaFor } from "./delta.js";
import { type Proposal, activeProposals, discoverProposals } from "./discover.js";
import { validateEars } from "./ears.js";

/**
 * The four spec-discipline rules from the plan, as checks.
 *
 * 1. Bootstrap brownfield with `/opsx:onboard` — OpenSpec's command, surfaced
 *    by `keel spec onboard` rather than reimplemented.
 * 2. Archive at merge, CI-gated.
 * 3. Cap spec size at ~250 lines per change.
 * 4. Attach the delta to the PR.
 *
 * Rules 2–4 are mechanical and live here. Rule 1 is a one-off human-reviewed
 * bootstrap, so it is documentation plus a passthrough, not a gate.
 */

export type SpecSeverity = "error" | "warning";

export interface SpecIssue {
  readonly rule: "archive-at-merge" | "spec-size" | "delta-present" | "proposal-required" | "ears";
  readonly change: string;
  readonly message: string;
  readonly fix: string;
  readonly severity: SpecSeverity;
}

/**
 * Rule 3 — size cap.
 *
 * Counted per *change*, across every markdown file in it, because that is the
 * unit a reviewer reads. A warning at the cap and an error at 1.5× it: the plan
 * says "~250", and failing a build over 251 lines would teach people to game
 * the number rather than write less.
 */
export function checkSize(config: KeelConfig, proposals: readonly Proposal[]): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const cap = config.spec.max_lines;

  for (const proposal of proposals) {
    if (proposal.archived) continue;
    if (proposal.lineCount <= cap) continue;

    const hard = proposal.lineCount > cap * 1.5;
    issues.push({
      rule: "spec-size",
      change: proposal.id,
      message: `spec is ${proposal.lineCount} lines against a ${cap}-line cap`,
      fix: "verbose specs are a defect, not thoroughness — cut it back, or split the change. If the spec is longer than the diff, something is wrong.",
      severity: hard ? "error" : "warning",
    });
  }

  return issues;
}

/**
 * Rule 2 — archive at merge.
 *
 * On the default branch, a proposal marked `applied` that still sits outside
 * `archive/` means the delta never folded into the capability spec. That is
 * exactly the documentation chore nobody does, which is why it is gated in CI
 * rather than left to a checklist.
 */
export function checkArchive(
  proposals: readonly Proposal[],
  onDefaultBranch: boolean,
): SpecIssue[] {
  if (!onDefaultBranch) return [];

  return proposals
    .filter((p) => !p.archived && p.status === "applied")
    .map((p) => ({
      rule: "archive-at-merge" as const,
      change: p.id,
      message: "merged but not archived — its delta has not folded into the capability spec",
      fix: `run \`openspec archive ${p.id}\` (or move ${p.relDir} under changes/archive/) and commit`,
      severity: "error" as const,
    }));
}

/**
 * Rule 4 — delta attached.
 *
 * A change with no delta markers cannot produce a PR comment worth reading, so
 * the absence is reported where it can still be fixed.
 */
export function checkDelta(root: string, proposals: readonly Proposal[]): SpecIssue[] {
  const issues: SpecIssue[] = [];

  for (const proposal of proposals) {
    if (proposal.archived) continue;
    if (deltaFor(root, proposal).length > 0) continue;

    issues.push({
      rule: "delta-present",
      change: proposal.id,
      message: "no ADDED/MODIFIED/REMOVED sections found",
      fix: "mark the delta in the change's spec files so `keel spec delta` can attach it to the PR",
      severity: "warning",
    });
  }

  return issues;
}

/**
 * Full-track changes need a proposal.
 *
 * Checked by `keel check` and in CI rather than by a per-edit hook: deciding
 * the track needs the router, and running caller counting on every Write would
 * cost more than every other gate combined. Rule of the road 1 — the quick
 * track must stay invisible — wins over catching this a few minutes earlier.
 */
export function checkProposalRequired(
  config: KeelConfig,
  track: Track,
  proposals: readonly Proposal[],
): SpecIssue[] {
  if (!config.spec.require_proposal_on_full) return [];
  if (track !== "full") return [];
  if (proposals.some((p) => !p.archived)) return [];

  return [
    {
      rule: "proposal-required",
      change: "(none)",
      message: "this change routes to the full track but has no OpenSpec proposal",
      fix: "run `keel spec new <change-id>` to scaffold one, then `openspec` owns the design phase from there. Override the track with `keel route --track standard` if the routing is wrong.",
      severity: "error",
    },
  ];
}

export interface SpecCheckOptions {
  readonly root: string;
  readonly config: KeelConfig;
  readonly onDefaultBranch?: boolean;
  /** Supply to also check the full-track proposal requirement. */
  readonly track?: Track;
}

export interface SpecCheckResult {
  readonly proposals: readonly Proposal[];
  readonly issues: readonly SpecIssue[];
  readonly errors: number;
  readonly warnings: number;
}

/** Run every spec-discipline check. */
export function checkSpecs(options: SpecCheckOptions): SpecCheckResult {
  const all = discoverProposals(options.root, options.config);
  const active = activeProposals(options.root, options.config);

  const issues: SpecIssue[] = [
    ...checkSize(options.config, all),
    ...checkArchive(all, options.onDefaultBranch === true),
    ...checkDelta(options.root, all),
    ...(options.track === undefined
      ? []
      : checkProposalRequired(options.config, options.track, all)),
    ...(options.config.spec.ears ? validateEars(options.root, active) : []),
  ];

  return {
    proposals: all,
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}
