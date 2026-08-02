#!/usr/bin/env node
/**
 * Bundles every hook entrypoint and the CLI into `scripts/` as standalone ESM.
 *
 * Why bundle: hooks run per tool call. Resolving a `node_modules` tree at hook
 * time costs more than the work most hooks do. One file, one read, no resolution.
 *
 * Why `typescript` stays external: it is ~8 MB and costs ~400 ms to evaluate.
 * Bundling it would move that cost from "lazily, when an AST gate matches a
 * TS file" to "every hook invocation". It is resolved from the plugin's own
 * node_modules only when `src/shared/ast/ts.ts` actually needs it.
 */
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, "scripts");

/** Bundle entrypoints: [source, output basename]. */
const ENTRYPOINTS = [
  ["src/cli/main.ts", "cli"],
  ["src/hooks/session-start.ts", "session-start"],
  ["src/hooks/pre-tool-use.ts", "pre-tool-use"],
  ["src/hooks/post-tool-use.ts", "post-tool-use"],
  ["src/hooks/post-bash.ts", "post-bash"],
  ["src/hooks/message-display.ts", "message-display"],
  ["src/hooks/session-end.ts", "session-end"],
];

/** Kept external: too large to bundle, loaded lazily and only when needed. */
const EXTERNAL = ["typescript"];

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const results = [];
  for (const [entry, name] of ENTRYPOINTS) {
    const outfile = join(outdir, `${name}.mjs`);
    const result = await build({
      entryPoints: [join(root, entry)],
      outfile,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      minify: true,
      sourcemap: false,
      external: EXTERNAL,
      legalComments: "none",
      banner: {
        // esbuild's ESM output can reference these when bundling CJS deps.
        js: [
          "import{createRequire as __kcr}from'node:module';",
          "import{fileURLToPath as __kfu}from'node:url';",
          "import{dirname as __kdn}from'node:path';",
          "const require=__kcr(import.meta.url);",
          "const __filename=__kfu(import.meta.url);",
          "const __dirname=__kdn(__filename);",
        ].join(""),
      },
      metafile: true,
    });
    const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
    results.push({ name, outfile, bytes });
  }

  await writeFile(
    join(outdir, "build-manifest.json"),
    `${JSON.stringify(
      { generated: "npm run build", entries: results.map((r) => ({ name: r.name, bytes: r.bytes })) },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const r of results) {
    console.log(`  ${r.name.padEnd(18)} ${(r.bytes / 1024).toFixed(1)} KB`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
