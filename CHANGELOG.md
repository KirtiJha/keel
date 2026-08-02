# Changelog

All notable changes to Keel. Format follows [Keep a Changelog]; versions follow
semver.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/

## [Unreleased]

### Blocked on human input

- **Upstream versions.** `upstream.lock` ships `superpowers` and `openspec` as
  `UNPINNED`. `keel check` fails on each and names the fix. Exact versions are
  required; `latest` is not acceptable (build spec §1).
- **Telemetry destination.** The local JSONL spool and `file` sink work.
  `keel telemetry ship` writes a local bundle and says the real sink is missing.
- **Org standards PDFs.** The pack format, loader, and gate runner are complete;
  only the two reference packs ship. Migrating the PDFs needs the PDFs.
- **Component MCP server schema.** M7 (UI bridge) is not started. No speculative
  client was written.

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
