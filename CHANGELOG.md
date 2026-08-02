# Changelog

All notable changes to Keel. Format follows [Keep a Changelog]; versions follow
semver.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/

## [Unreleased]

### Added

- **Mutation testing** (`keel mutate`). Diff-only, deterministic, gated on
  score with a 50% starting floor that ratchets. AST-driven operators for both
  languages; the runner drives the repo's own test command and always restores
  the file. Completes plan week 8 and rule of the road 4. A test asserts it
  catches the tautological-test failure mode that assertion lint cannot see.
- **Full-track spec discipline** (`keel spec`). The plan's four rules: archive
  at merge (CI-gated on the default branch), the ~250-line cap, delta rendering
  for PR comments, and a full-track proposal requirement. `keel spec new`
  scaffolds structure and no content; `keel spec onboard` hands over to
  OpenSpec's `/opsx:onboard` rather than reimplementing it.
- **EARS acceptance criteria**, off by default. The plan says try it on two
  changes before deciding, so `spec.ears: true` warns and never blocks.
- **Review chain** (`keel review`). Assembles rubric-filtered review input plus
  the spec delta, and documents the chain order. `--prompt` emits it for piping.
- **PR comment telemetry** (`keel review record`). Counts only — the plan's
  headline metric is "human PR comments down 40%", which needs recording.
- **`migration-safety` reference pack**, `mode: review`. Third reference pack,
  completing one template per mode.
- **Superspec pinned as a pattern source.** Its contribution — "the wiring
  between those two: OpenSpec plans, Superpowers builds" — is Keel's own phase
  map. Recorded for provenance; identification is unconfirmed and flagged in
  the lock file.
- CI jobs for the mutation gate, the spec-discipline gate and delta attachment.
- **Effort by track is applied, not just computed.** `keel route --apply-effort`
  writes `effortLevel` to `.claude/settings.local.json` — local scope, because
  the level follows *this* change's track and committing it would pin the team.
- **`keel upstream status|install`.** Verifies pinned versions against what is
  actually in `node_modules`, and runs the `install:` commands recorded in
  `upstream.lock` — commands a human wrote, never composed from guesses.
  `keel init` reports drift unless `--no-install`.
- **`src/shared/settings.ts`**, one place for merging Claude Code settings:
  merge never replace, never reverse a deliberate value, never overwrite a file
  that will not parse.
- `skillOverrides` wiring for `upstream.disabled_skills`, with the plugin-skill
  limitation reported rather than papered over.

### Changed

- **Upstream is pinned.** Superpowers `6.2.0` (planning, implementation) and
  OpenSpec `@fission-ai/openspec@1.7.0` (design, spec-conformance) are installed
  and pinned to exact versions. `keel check` passes on this repository.
- **Spec Kit `0.15.1` is pinned as a `pattern-source`, not installed.** The plan
  takes two ideas from it and nothing else; its `/speckit.specify` and
  `/speckit.plan` would claim design and planning, which OpenSpec and
  Superpowers already own. A new `role` field distinguishes an installed
  dependency from one we only borrowed ideas from, and a pattern source
  declaring `owns:` is an error.
- **`engines.node` raised to `>=20.19.0`** to match OpenSpec's requirement.
  Previously `>=20`, under which a Node 20.0 install would fail at runtime.
- **`upstream.lock` now cross-checks phase ownership.** Each dependency's
  `owns:` is validated against `PHASE_OWNERS`, and two dependencies claiming one
  phase is an error — completing the M2.3 requirement.
- **`keel init` writes `SUPERPOWERS_DISABLE_TELEMETRY=1`** into
  `.claude/settings.json` (M2.5), merging rather than overwriting and never
  reversing a deliberate override.

### Blocked on human input

- **Telemetry destination.** The local JSONL spool and `file` sink work.
  `keel telemetry ship` writes a local bundle and says the real sink is missing.
- **Org standards PDFs.** The pack format, loader, and gate runner are complete;
  only the three reference packs ship. Migrating the PDFs needs the PDFs.
- **Component MCP server schema.** M7 (UI bridge) is not started. No speculative
  client was written.
- **Internal mirrors** for the two installed dependencies. Reported by
  `keel check` as a warning, not an error, so the lock is usable now.

## [0.1.0] — initial build

### Added

**M0 — Foundation.** TypeScript strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. vitest with coverage reported, never gated. esbuild
bundling per hook entrypoint. `python/keel_gates` with pytest, ruff (including
`BLE`) and mypy `--strict`. GitHub Actions running typecheck, lint, build,
bundle-size, tests, hook cold-start benchmark, Python checks, and a dogfooded
`keel check`.

**M1 — Config and CLI.** `keel init`, `check`, `doctor`, `route`, `gotchas`,
`telemetry`, `version`. `keel.config.yaml` validated by a Zod schema that also
generates the published JSON Schema. Invalid config produces an error naming the
field and the fix.

**M2 — Upstream composition.** `upstream.lock` format with pin validation that
rejects `latest` and floating ranges. Phase-ownership map with conflict detection
across plugin, `.claude/skills/` and repo skills — `keel check` fails and names
both claimants.

**M3 — Router.** Deterministic, escalate-only track classification. Symbol
analysis via the lazily-loaded TypeScript compiler API and Python's stdlib `ast`.
Caller counting via `git grep`. Content-hashed per-commit cache under
`.keel/cache/`, no daemon. 35-fixture suite running against real temp git repos.

**M4 — Standards packs.** Folder-based packs with `gate`, `guide` and `review`
modes. Diff-only enforcement in the runner, not per pack. On-demand TypeScript
transpilation of `rule.ts` so pack authors need no build step. Repo-local packs
override org packs, and the override is reported. Two reference packs:
`no-raw-color-values` (TypeScript AST) and `error-envelope` (both languages).

**M5 — Context layer.** CLAUDE.md generator under 60 lines with managed markers,
emitting exact commands and no config-inferable facts. Gotcha scanner across four
signals, every candidate requiring human confirmation. Path-based skill routing
with per-session deduplication.

**M6 — TDD gates.** Test weakening (with an explicit per-framework matcher
downgrade map and a reason-carrying override), mocking the unit under test,
observed RED (per-branch state driven by ordinary test runs), and assertion lint.
Fixture pairs in TypeScript and Python for each. `exempt_globs` and `KEEL_SPIKE`
honoured. Zero false positives asserted across this repo's own suite.

**M8 — Output layer.** `keel` output style. MessageDisplay formatter producing
the four-row format, display-only, fail-safe, and structurally unable to drop a
`decide` line. Quiet gates: every hook sets `suppressOutput` and a
`statusMessage`. Local JSONL telemetry spool with an allowlist serialiser and a
test asserting no source code, paths, or prompts reach disk.

**M9 — Distribution.** `plugin.json`, `marketplace.json`, and `hooks.json`
registering six hooks in exec form under `${CLAUDE_PLUGIN_ROOT}`. `keel-reviewer`
subagent installed to `.claude/agents/` by `keel init`, which is idempotent and
never clobbers hand-edited content.

### Performance

Measured, not assumed. Budgets in `scripts-dev/bench-*.mjs` and CI.

| Path | Budget | Measured |
|---|---|---|
| Router classification, 5,000 files | 150 ms | 39 ms warm p95 |
| Gate runner, per file | 200 ms | 31 ms p95 |
| MessageDisplay formatter, 500 messages | 100 ms | 0.1 ms p95 |
| Hook cold start, Keel's own cost | 80 ms | 32–73 ms p50 |

### Notable decisions

Full rationale in `docs/decisions.md`.

- The TypeScript compiler API costs ~400 ms to import and is loaded lazily, only
  when a gate needs an AST.
- Hooks never import zod (~26 ms module init per tool call). Strict validation
  lives in the CLI; hooks use a coercing reader. A cross-check test and a bundle
  grep prevent drift.
- Hook cold start is gated on p50 with p95 reported, because p95 on a shared
  runner is scheduler noise.
- A crashed gate fails open; only a detected violation exits 2.
- `scripts/` is committed build output, verified against a fresh build in CI.

### Fixed during the build

- Router counted its own `.keel/` cache as a changed file, and `git grep
  --untracked` matched symbol names inside cached JSON, inflating caller counts.
  Both found by the router fixture suite.
- Deleting a module did not register its removed exports.
- Gate 4 misread curried `it.each(table)(name, fn)` as assertion-free, and
  treated `toBeDefined`/`toBeNull` as weak matchers. Both found by the M6
  zero-false-positive acceptance test.
- A pack rule that never resolved hung the hook until Claude Code's timeout;
  bounded by a 2-second per-rule timeout in the runner.
- Redaction missed secret values in structured data whose key — not value —
  marked them secret.
- Gate 1 named tests with a non-literal title by line number, so any edit above
  one made it look deleted. Named by ordinal instead. Found by the M6
  zero-false-positive test after the config corpus grew.
