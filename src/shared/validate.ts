/**
 * Dependency-free coercion helpers for the runtime (hook) path.
 *
 * Constraint 0.9 asks for two different behaviours: "Fail loud at `keel init`.
 * Fail safe at runtime." Zod provides the loud half, in the CLI. These provide
 * the safe half, in hooks — where importing zod costs ~26 ms of module init on
 * *every tool call*, measured, which is more than the rest of a hook put
 * together.
 *
 * Every function here takes `unknown` and a fallback, and can only ever return
 * the fallback or a well-typed value. Nothing throws.
 *
 * The two paths are kept honest by a cross-check test that runs the same corpus
 * through both and asserts identical output.
 */

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

export function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asInt(value: unknown, fallback: number, min = Number.NEGATIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) return fallback;
  return value;
}

export function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** A list of non-empty strings, or the fallback when the shape is wrong. */
export function asStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.filter((v): v is string => typeof v === "string" && v !== "");
  // An array that was present but entirely unusable is a config error, not an
  // intent to empty the list — fall back rather than silently disabling a rule.
  return out.length === 0 && value.length > 0 ? [...fallback] : out;
}

/** A list restricted to an enum. */
export function asEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.filter((v): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v));
  return out.length === 0 ? [...fallback] : out;
}

/** A plain object, or an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read a nested key path without throwing. */
export function at(value: unknown, ...keys: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of keys) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}
