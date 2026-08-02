#!/usr/bin/env node
/**
 * Bundle-size check (M0.5).
 *
 * Size is a proxy for the thing that actually matters — module-init time on
 * every tool call. The limits below are set just above the current sizes so a
 * dependency accidentally pulled into a hook shows up as a failed build rather
 * than as a session that quietly got slower.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = join(root, "scripts");

/**
 * Per-bundle ceilings in KB.
 *
 * The CLI and SessionStart legitimately carry zod: the CLI validates configs,
 * and SessionStart imports the validator lazily so its cost is paid once per
 * session rather than per tool call. Every other hook must stay zod-free, and
 * the tight limits here are what enforce that.
 */
const LIMITS_KB = {
  cli: 700,
  "session-start": 600,
  "pre-tool-use": 220,
  "post-tool-use": 240,
  "post-bash": 190,
  "message-display": 190,
  "session-end": 190,
};

let failures = 0;
console.log("\nBundle sizes\n");
console.log(`  ${"bundle".padEnd(20)}${"size".padEnd(12)}${"limit".padEnd(12)}status`);

for (const [name, limitKb] of Object.entries(LIMITS_KB)) {
  const file = join(scripts, `${name}.mjs`);
  let sizeKb;
  try {
    sizeKb = statSync(file).size / 1024;
  } catch {
    console.error(`  ${name.padEnd(20)}missing — run \`npm run build\``);
    failures++;
    continue;
  }

  const over = sizeKb > limitKb;
  if (over) failures++;
  console.log(
    `  ${name.padEnd(20)}${`${sizeKb.toFixed(1)} KB`.padEnd(12)}${`${limitKb} KB`.padEnd(12)}${over ? "OVER LIMIT" : "ok"}`,
  );
}

/**
 * A hook bundle containing zod means the fast config reader has been bypassed
 * somewhere. Size alone would not catch it if another dependency shrank, so
 * check for the marker directly.
 */
const ZOD_FREE = ["pre-tool-use", "post-tool-use", "post-bash", "message-display", "session-end"];
console.log("");
for (const name of ZOD_FREE) {
  try {
    const text = readFileSync(join(scripts, `${name}.mjs`), "utf8");
    // A distinctive string from zod's runtime, absent from our own code.
    if (text.includes("$ZodError") || text.includes("zod/v4")) {
      console.error(`  ${name}: bundles zod — use the reader in shared/config.ts, not config-schema.ts`);
      failures++;
    }
  } catch {
    // Missing bundles are already reported above.
  }
}

console.log("");
if (failures > 0) {
  console.error(`${failures} bundle check(s) failed`);
  process.exit(1);
}
console.log("  all bundles within limits, hooks are zod-free\n");
