# Changelog

All notable changes to Keel. Format follows [Keep a Changelog]; versions follow
semver.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/

## [Unreleased]

### Fixed — docs, CI and packaging

A remediation pass over claims that were wrong, unverifiable, or missing. Each
item below was checked against the source; where a claim could not be
reproduced, the number was removed rather than restated.

**Documentation**

- **There is now an install section, and there was none before.** Neither
  getting the `keel` CLI onto PATH nor registering the plugin with Claude Code
  was documented anywhere, while the README used `keel init` as though the
  binary existed and the whole hooks/skills/output-style story silently required
  a plugin registration. `.claude-plugin/marketplace.json` had shipped since
  0.1.0 and was referenced by nothing. This was the single biggest adoption
  blocker in the repository.
- **Stated scope, plainly: Claude Code only, TypeScript and Python only.** Every
  comparable tool — Spec Kit, OpenSpec, Superpowers — is agent- and
  language-agnostic. A Go team should learn that from the README, not from an
  afternoon.
- **The real zero-to-value path.** Notably: *commit what `keel init` writes*.
  The router classifies the working tree and excludes only `.keel/`, so the six
  uncommitted setup files exceed `quick_max_files: 1` and the very next two-line
  fix routes to standard. Also documents which of those files belong in git, and
  which parts of `.keel/` are actually disposable.
- **Test layout documented, and it needs no workaround.** Verified against
  `src/tdd/pairing.ts`: colocated, `__tests__/`, flat `tests/`, first-segment
  swap and whole-path mirror all pair, under `tests/`, `test/`, `spec/` and
  `__tests__/`, in both languages and in monorepo layouts. An unrecognised
  layout leaves gate 3 silent rather than blocking.
- **Performance claims replaced with budgets and reproduction commands.** The
  published "39 ms warm p95" router figure and "32–73 ms p50" hook figure were
  single runs of measurements that do not reproduce; the router's own test
  records 59–182 ms warm p95 on unchanged code. Only the MessageDisplay row was
  re-measured (p50 0.06 ms / p95 0.14 ms over 500 messages) and kept. Cold-cache
  cost — `import('typescript')` at ~400 ms, plus an empty `.keel/cache/` — was
  never disclosed and now is.
- **Reference-pack count corrected to three** in `README.md` and `CHANGELOG.md`.
  The README said two in one place and three in two others; three ship, one per
  mode.
- **`docs/decisions.md` "tempting to stub" corrected.** It claimed no
  `mode: review` reference pack ships and that "neither reference pack is
  naturally a rubric". `standards/migration-safety/` is `mode: review` and ships
  a `rubric.md`.
- **The mutation floor's ratchet claim.** The README said the floor ratchets off
  "the trend `keel doctor` reports". `doctor` reports no mutation data at all,
  and neither does `keel telemetry show`; `mutationTrend()` exists in
  `src/telemetry/ship.ts` with no caller. The README now says what exists.
- **`/verify` removed from the README.** No `commands/` directory ships and
  `plugin.json` declares no `commands`, so the command does not exist. (It is
  still listed in `CHAIN` in `src/cli/commands/review.ts`.)
- **`skills/keel-spec` no longer mischaracterises OpenSpec.** `/opsx:onboard` is
  a guided walkthrough that produces one small real change — not a
  reverse-engineering pass over a legacy service — and it is **expanded-profile
  only**, so on a default OpenSpec install the command Keel hands off to does
  not exist. OpenSpec ships nothing that generates specs from existing code; the
  skill now says how a legacy repo actually accretes specs.
- **`skills/keel-standards` no longer tells pack authors to import from
  `../../src/standards/types.js`.** That path resolves only inside the Keel
  checkout, so it broke editor and `tsc` for every real pack author. The rule
  contract is now declared inline — which is free, because rules are matched
  structurally and `import type` is erased before a rule runs.
- **`skills/keel-init` no longer calls `.keel/` "safe to delete".** It holds
  `tdd-state.json`; deleting it discards observed-RED history and re-blocks the
  developer. Only `.keel/cache/` is disposable.
- **`CLAUDE.md` no longer claims the track "is chosen automatically".** Nothing
  invokes the router — the SessionStart hook injects a reminder. The
  classification is deterministic; running it is advisory, and CI is where the
  process gates actually bite.
- **`README` config example matches what `init` writes** (`keel-standards@0.1.0`,
  not `@1.0.0`), and **documents the four undocumented sections** — `upstream`,
  `display`, `spec` and `mutation` — appearing in neither the example nor the
  generated file. `mutation.test_command` was previously discoverable only from
  an error message.

**CI**

- **The spec-delta PR comment can now post.** The workflow set
  `permissions: contents: read` with no job override, so `gh pr comment` 403'd on
  every PR since the job was added — silently, because the step carries
  `continue-on-error`. `pull-requests: write` is now granted to the
  `spec-discipline` job alone.
- **The cold-start benchmark reports instead of gating.** It computes
  `own = p50 − spawnFloor`, one noisy number minus another: three consecutive
  runs on identical code gave 3, 1 and 1 hooks over budget while the measured
  spawn floor moved 57 → 84 ms. It cannot distinguish a 30 ms regression from
  scheduler jitter, so it gates nothing until the methodology is fixed — the
  workflow and `docs/decisions.md` §3 both say what fixing it requires.
  `npm run verify` drops it too, where it had been sitting mid-chain and
  skipping the Python suite on a flake.
- **The mutation gate runs on pushes to `main`, not only on PRs.** Mutation score
  is this project's stated replacement for coverage, so a direct push — the one
  change no reviewer saw — was exactly the wrong thing to exempt. Pushes diff
  against `HEAD^`, which is the previous default-branch tip for a merge, a
  squash or a fast-forward alike.
- **Python CI tooling is pinned exactly** (`pytest==9.0.2`, `ruff==0.15.8`,
  `mypy==1.19.1`) — the versions the suite was last verified green against.
  `pip install pytest ruff mypy` let CI break with no commit behind it, which is
  the failure `keel check` treats as a hard error in `upstream.lock`.
- **`npm run lint` covers `scripts-dev/`.** The benchmark scripts were the only
  first-party JavaScript nothing linted.
- **New `standards-gates` job running `keel gate`.** Until it existed the gates
  ran in exactly one place — Claude Code's PostToolUse hook — so any change
  written in another editor, by a bot, or by anyone without the plugin met no
  org rules at all, and CI could not run them. Diff-only and blocking-severity
  only, same as the hook.

**Packaging**

- `package.json` `files` includes `templates`, for the subagent templates that
  cannot ship inside the plugin.
- **`.claude-plugin/plugin.json` deliberately still declares no `agents` key**,
  and should not gain one. Reasoning in `docs/decisions.md` §17: plugin-packaged
  subagents cannot carry `permissionMode`, which `keel-reviewer` sets, so
  declaring the directory would re-register the exact file that needs `keel init`
  to install it.

### Decided

- **No managed settings in v1.** Every gate ships overridable, including the two
  `docs/managed-settings.md` recommends locking. Answers M9.4's first question;
  see `docs/decisions.md` §16.
- **Telemetry is on by default and local-only.** No remote sink exists or is
  planned, which retires the "telemetry destination" blocked input — the
  destination is the local file. `keel telemetry ship` and the module comments
  no longer describe the file sink as a stand-in for something missing.

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
override org packs, and the override is reported. Two reference packs **at this
release**: `no-raw-color-values` (TypeScript AST) and `error-envelope` (both
languages). The third, `migration-safety` (`review`), lands in [Unreleased];
three ship today.

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

> **Three of these four figures are retracted.** They are single runs of
> measurements that do not reproduce on a shared machine — the router's own test
> later recorded warm p95 ranging 59–182 ms on unchanged code. Left here because
> a changelog records what was claimed at the time; see [Unreleased] and the
> README's Performance section for what replaced them. Only the formatter row
> was re-measured and held.

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
