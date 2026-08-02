import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { configPath, isFile } from "../shared/paths.js";
import { errorMessage } from "../shared/result.js";

/**
 * Is `keel.config.yaml` readable at all?
 *
 * `loadConfigOrDefaults` swallows a YAML syntax error and hands back defaults,
 * which is the right behaviour for a hook — a broken config must not stop an
 * edit — but wrong for a command a person is watching. `keel route` ran on
 * defaults in silence: `force_full_globs` stopped applying, migrations stopped
 * routing to full, and nothing said so.
 *
 * Deliberately cheap: a file read and a YAML parse, no zod. Schema validation
 * costs ~26 ms of module init and is `keel check`'s job; this answers only the
 * question every command needs answered, which is whether the file on disk is
 * the one being obeyed.
 */

export type ConfigHealth =
  | { readonly state: "absent" }
  | { readonly state: "ok" }
  | { readonly state: "unparseable"; readonly error: string }
  | { readonly state: "not-a-mapping" };

export function configHealth(repoRoot: string): ConfigHealth {
  const path = configPath(repoRoot);
  if (!isFile(path)) return { state: "absent" };

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    return { state: "unparseable", error: errorMessage(cause).split("\n")[0] ?? "invalid YAML" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "not-a-mapping" };
  }
  return { state: "ok" };
}

/** A one-line warning plus its fix, or null when the config is usable. */
export function configWarning(
  repoRoot: string,
  health: ConfigHealth,
): { readonly message: string; readonly fix: string } | null {
  switch (health.state) {
    case "ok":
    case "absent":
      return null;
    case "unparseable":
      return {
        message: `${configPath(repoRoot)} is not valid YAML (${health.error}) — running on defaults, so router settings such as force_full_globs are NOT being applied`,
        fix: "fix the YAML syntax, then re-run; `keel check` names the line",
      };
    case "not-a-mapping":
      return {
        message: `${configPath(repoRoot)} is not a mapping — running on defaults, so router settings such as force_full_globs are NOT being applied`,
        fix: "the file must be a YAML mapping starting with `version: 1`; `keel init --force` rewrites a known-good one",
      };
  }
}
