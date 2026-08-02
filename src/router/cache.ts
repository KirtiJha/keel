import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { keelSubdir } from "../shared/paths.js";

/**
 * Per-commit cache under `.keel/cache/`.
 *
 * Build spec M3: "Cache per-commit ... invalidated by file mtime + content
 * hash. No persistent index, no daemon." So the cache key carries the content
 * hash, which makes staleness impossible rather than merely unlikely — a stale
 * entry cannot be addressed, so it is never read.
 */

export function hashContent(...parts: readonly string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 32);
}

function cacheFile(root: string, namespace: string, key: string): string {
  return join(keelSubdir(root, "cache", namespace), `${key}.json`);
}

export function cacheGet<T>(root: string, namespace: string, key: string): T | null {
  try {
    return JSON.parse(readFileSync(cacheFile(root, namespace, key), "utf8")) as T;
  } catch {
    return null;
  }
}

export function cacheSet<T>(root: string, namespace: string, key: string, value: T): void {
  try {
    mkdirSync(keelSubdir(root, "cache", namespace), { recursive: true });
    writeFileSync(cacheFile(root, namespace, key), JSON.stringify(value), "utf8");
  } catch {
    // A cache that cannot write is a slow cache, not a broken one.
  }
}

/** Memoise through the on-disk cache. */
export function cached<T>(
  root: string,
  namespace: string,
  key: string,
  compute: () => T,
): T {
  const hit = cacheGet<T>(root, namespace, key);
  if (hit !== null) return hit;
  const value = compute();
  cacheSet(root, namespace, key, value);
  return value;
}

export async function cachedAsync<T>(
  root: string,
  namespace: string,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(root, namespace, key);
  if (hit !== null) return hit;
  const value = await compute();
  cacheSet(root, namespace, key, value);
  return value;
}
