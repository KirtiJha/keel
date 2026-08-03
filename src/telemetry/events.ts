import { createHash } from "node:crypto";

import type { Track } from "../shared/config.js";
import { redact } from "../shared/redact.js";

/**
 * Telemetry events and their serialiser.
 *
 * The serialiser *is* the privacy control. Build spec M8: "No file contents, no
 * code, no prompts, no secrets."
 *
 * Each event kind is written out field by field from a fixed allowlist. Unknown
 * fields are never read, so they cannot be written — a call site that adds a
 * `snippet` or a `filePath` produces the same output as one that does not. That
 * is a stronger guarantee than schema rejection: there is no path from an
 * unexpected input field to the file on disk, and it holds without importing a
 * schema library into hooks (~26 ms per tool call, measured).
 *
 * Paths are excluded on purpose. They are not source code, but they leak
 * product and customer names, and nothing in the M8 field list needs them.
 */

export const TRACKS: readonly Track[] = ["quick", "standard", "full"];

/**
 * `untrusted` and `skipped` are not failures and not passes.
 *
 * Folding them into `pass` is how a gate that never ran comes to look like a
 * gate that found nothing — which is the exact reading the telemetry exists to
 * prevent. "This pack has not fired in a quarter" means something very
 * different if the pack has not been approved to run.
 */
export type GateResultKind = "pass" | "fail" | "warn" | "error" | "untrusted" | "skipped";
export type TddGateName = "test-weakening" | "mock-under-test" | "observed-red" | "assertion-lint";
export type TddResultKind = "pass" | "block" | "skip" | "error";
export type Severity = "high" | "medium" | "low";

interface BaseFields {
  readonly ts: string;
  readonly version: string;
  readonly repo_id: string;
  readonly session: string;
}

export type TelemetryEventInput =
  | {
      readonly kind: "route";
      readonly track: Track;
      readonly escalated_from?: Track;
      readonly reason_count: number;
      readonly changed_files: number;
      readonly changed_lines: number;
      readonly duration_ms: number;
    }
  | {
      readonly kind: "override";
      readonly from: Track;
      readonly to: Track;
      readonly direction: "up" | "down";
    }
  | {
      readonly kind: "gate";
      readonly pack: string;
      readonly severity: Severity;
      readonly result: GateResultKind;
      readonly finding_count: number;
      readonly duration_ms: number;
    }
  | {
      readonly kind: "tdd_gate";
      readonly gate: TddGateName;
      readonly result: TddResultKind;
      readonly overridden: boolean;
      readonly duration_ms: number;
    }
  | { readonly kind: "spike"; readonly enabled: boolean }
  | {
      readonly kind: "mutation";
      /** killed / (killed + survived), rounded to 3 places. */
      readonly score: number;
      readonly killed: number;
      readonly survived: number;
      readonly total: number;
      readonly passed: boolean;
      readonly duration_ms: number;
    }
  | {
      /**
       * PR review outcome. Plan success metric: "human PR comments down 40%",
       * which needs the count to be recorded somewhere.
       *
       * Counts only. No comment bodies, no author names, no PR titles — the
       * same rule as everything else here.
       */
      readonly kind: "pr_review";
      readonly human_comments: number;
      readonly bot_comments: number;
      readonly review_count: number;
      readonly changed_files: number;
      readonly track: Track;
    }
  | {
      readonly kind: "hook_timing";
      readonly hook: string;
      readonly duration_ms: number;
      readonly loaded_ast: boolean;
    };

export type TelemetryEvent = TelemetryEventInput & BaseFields;

const isTrack = (v: unknown): v is Track => typeof v === "string" && TRACKS.includes(v as Track);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The allowlist above is the primary control: a field the serialiser does not
 * name cannot reach disk. These two — a pack name and a hook name — are the only
 * free text that *is* named, so they are scrubbed as well. Both are constrained
 * upstream (pack names are regex-validated in `standard.yaml`, hook names come
 * from Claude Code), which is exactly why this is cheap: it costs nothing on the
 * values we expect and closes the one path a string could travel.
 *
 * Constraint 0.10 names telemetry explicitly, and defence in depth on the only
 * free-text field is the whole of the difference between "no known leak" and
 * "no leak".
 */
const text = (v: unknown): string => redact(str(v));
const bool = (v: unknown): boolean => v === true;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Every member of `GateResultKind`, and the compile-time check that keeps it
 * that way.
 *
 * Widening the type without widening this array silently rewrote `untrusted`
 * and `skipped` to `pass` on disk — the exact misreading the type's own comment
 * exists to prevent, reintroduced one file away from it. `readonly Kind[]`
 * cannot catch a missing member, so the mapped-object form below does: leaving
 * one out is a type error.
 */
const GATE_RESULT_SET: { readonly [K in GateResultKind]: true } = {
  pass: true,
  fail: true,
  warn: true,
  error: true,
  untrusted: true,
  skipped: true,
};
const GATE_RESULTS = Object.keys(GATE_RESULT_SET) as readonly GateResultKind[];
const TDD_GATES: readonly TddGateName[] = [
  "test-weakening",
  "mock-under-test",
  "observed-red",
  "assertion-lint",
];
const TDD_RESULTS: readonly TddResultKind[] = ["pass", "block", "skip", "error"];
const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

/**
 * Build the on-disk record for one event.
 *
 * Returns null for an unrecognised kind rather than writing something partial.
 * Every branch reads only the fields it names.
 */
export function serialiseEvent(
  input: unknown,
  base: BaseFields,
): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null) return null;
  const e = input as Record<string, unknown>;

  switch (e["kind"]) {
    case "route": {
      if (!isTrack(e["track"])) return null;
      const escalated = e["escalated_from"];
      return {
        ...base,
        kind: "route",
        track: e["track"],
        ...(isTrack(escalated) ? { escalated_from: escalated } : {}),
        reason_count: num(e["reason_count"]),
        changed_files: num(e["changed_files"]),
        changed_lines: num(e["changed_lines"]),
        duration_ms: num(e["duration_ms"]),
      };
    }

    case "override": {
      if (!isTrack(e["from"]) || !isTrack(e["to"])) return null;
      return {
        ...base,
        kind: "override",
        from: e["from"],
        to: e["to"],
        direction: oneOf(e["direction"], ["up", "down"] as const, "up"),
      };
    }

    case "gate":
      return {
        ...base,
        kind: "gate",
        pack: text(e["pack"]),
        severity: oneOf(e["severity"], SEVERITIES, "medium"),
        result: oneOf(e["result"], GATE_RESULTS, "pass"),
        finding_count: num(e["finding_count"]),
        duration_ms: num(e["duration_ms"]),
      };

    case "tdd_gate":
      return {
        ...base,
        kind: "tdd_gate",
        gate: oneOf(e["gate"], TDD_GATES, "assertion-lint"),
        result: oneOf(e["result"], TDD_RESULTS, "pass"),
        overridden: bool(e["overridden"]),
        duration_ms: num(e["duration_ms"]),
      };

    case "spike":
      return { ...base, kind: "spike", enabled: bool(e["enabled"]) };

    case "mutation":
      return {
        ...base,
        kind: "mutation",
        score: num(e["score"]),
        killed: num(e["killed"]),
        survived: num(e["survived"]),
        total: num(e["total"]),
        passed: bool(e["passed"]),
        duration_ms: num(e["duration_ms"]),
      };

    case "pr_review": {
      if (!isTrack(e["track"])) return null;
      return {
        ...base,
        kind: "pr_review",
        human_comments: num(e["human_comments"]),
        bot_comments: num(e["bot_comments"]),
        review_count: num(e["review_count"]),
        changed_files: num(e["changed_files"]),
        track: e["track"],
      };
    }

    case "hook_timing":
      return {
        ...base,
        kind: "hook_timing",
        hook: text(e["hook"]),
        duration_ms: num(e["duration_ms"]),
        loaded_ast: bool(e["loaded_ast"]),
      };

    default:
      return null;
  }
}

/** Read a spooled line back, dropping anything that is not a known event. */
export function parseEvent(raw: unknown): TelemetryEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;

  const base: BaseFields = {
    ts: str(e["ts"]),
    version: str(e["version"]),
    repo_id: str(e["repo_id"]),
    session: str(e["session"]),
  };

  const serialised = serialiseEvent(e, base);
  return serialised === null ? null : (serialised as unknown as TelemetryEvent);
}

/** Stable, non-reversible repo identifier. */
export function repoId(repoName: string): string {
  return createHash("sha256").update(repoName).digest("hex").slice(0, 16);
}
