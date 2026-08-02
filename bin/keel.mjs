#!/usr/bin/env node
// Thin shim. The real CLI is the esbuild bundle in `scripts/cli.mjs`.
// Kept separate so `bin` is stable and committed while `scripts/` is build output.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "scripts", "cli.mjs");

if (!existsSync(bundle)) {
  process.stderr.write(
    "keel: bundle missing at scripts/cli.mjs — run `npm run build` in the keel checkout.\n",
  );
  process.exit(1);
}

await import(bundle);
