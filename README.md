# Keel

Spec-driven development as a Claude Code plugin. Keel decides how much process a
change actually needs, enforces standards and TDD while the code is being
written, and keeps the terminal readable.

*A keel is the backbone a ship is built around. Small, structural, invisible once
you're sailing.*

---

## What it does

```
  idea
   │
   ▼
 [ router ] ──► quick ──────────────────────────────┐
   │                                                │
   ├──────────► standard ── plan ── build ──────────┤
   │                                                │
   └──────────► full ── proposal ── plan ── build ──┤
                                                    │
                                                    ▼
                              ┌──── while coding ────┐
                              │  hooks: standards,   │
                              │  TDD gates           │
                              └──────────┬───────────┘
                                         ▼
                                    review → PR
```

Three tracks. The router picks one from the diff; developers can override either
way. Hooks run on every track; the review chain runs on standard and full.

| Track | When | Process |
|---|---|---|
| **quick** | one file, small, no interface change | build, hooks run, done |
| **standard** | multi-file, or an exported signature changed | plan → build (test-first) → verify |
| **full** | migrations, auth, openapi, or a widely-called symbol crossing a package boundary | proposal → plan → build → verify → archive |

**Classification is automatic; running it is not.** `keel route` is a read — you
run it, or you don't. The SessionStart hook injects a reminder that tracks exist
and nothing more; no hook invokes the router, because counting callers with
`git grep` on every Write would cost more than every other gate put together
(`docs/decisions.md` §12). What *is* automatic is the answer: the classifier is
a pure function of the diff with no clock, no LLM and no filesystem, so the same
change always routes the same way and the track is never a matter of opinion.
The process gates that matter — full-track proposals, the spec cap, the archive
rule — are enforced by `keel spec check` in CI, where a human is already
waiting.

Reasoning effort follows the track — quick → `low`, standard → `medium`,
full → `high`. `keel route --apply-effort` writes it to
`.claude/settings.local.json`; per-turn overrides are Claude Code's own.

**A quick change must feel like no process at all.** If a two-line fix feels
slower with Keel than without it, the router is wrong — that is a bug, not a
tuning exercise.

---

## Scope

Stated up front rather than discovered three days in.

**Claude Code only.** The gates run as Claude Code hooks, the skills and output
style are a Claude Code plugin, and there is no CLI-only mode that reproduces
in-loop enforcement. On Cursor, Copilot, Aider or a bare terminal, none of it
fires. The CLI still answers questions; nothing stops anything.

**TypeScript and Python only.** Symbol extraction for the router, the gate
runner's AST layer, the TDD gates' test pairing and the mutation operators are
all per-language, and those are the two that are implemented. A Go or Rust
repository would get path-glob routing and nothing else, which is not enough to
be worth installing.

Every comparable tool is broader on both axes — Spec Kit, OpenSpec and
Superpowers are agent-agnostic and language-agnostic. Keel trades that reach for
enforcement that happens while the code is being written instead of after. If
you need the reach, one of those is the better tool, and Keel composes with two
of them anyway (see [Upstream](#upstream)).

---

## Install

Two things have to happen and neither is optional: the `keel` CLI has to be on
your PATH, and the plugin has to be registered with Claude Code. **The hooks,
skills and output style come from the plugin registration.** Nothing in
`keel.config.yaml` turns them on — a repo with the config and no plugin has
documentation, not gates.

### 1. The CLI

Keel is not on npm: `package.json` is `private: true` while it is internal.
Install it from a checkout.

```bash
git clone https://github.com/KirtiJha/keel
cd keel
npm install
npm run build      # scripts/ is committed, but rebuild after any pull
npm link           # puts `keel` on your PATH; `npm unlink -g @keel/keel` undoes it
```

If you would rather not link globally, every `keel <command>` below also works
as `node /path/to/keel/scripts/cli.mjs <command>` — `bin/keel.mjs` is a thin
shim over exactly that, and it will tell you to run `npm run build` if the
bundle is missing.

### 2. The plugin

In Claude Code:

```
/plugin marketplace add KirtiJha/keel
/plugin install keel@keel-internal
/reload-plugins
```

`.claude-plugin/marketplace.json` declares the marketplace as `keel-internal`
and the plugin as `keel` with `source: "./"`, so this repository is both. A
local checkout works in place of the GitHub reference:
`/plugin marketplace add /path/to/keel`.

Check it took: `/plugin` should list `keel` as enabled, and a new session should
start with Keel's process notes injected — that is the SessionStart hook, and it
is the cheapest proof the plugin is live.

---

## Setting up a repository

```bash
cd your-repo
keel init
git add keel.config.yaml upstream.lock .gitignore CLAUDE.md .claude/
git commit -m "chore: keel init"
keel check         # validates config, packs, phase ownership, upstream pins
keel doctor        # what is active, how fast it runs, how often gates fire
```

**Commit what `keel init` writes before you make another change.** `init` prints
the exact `git add` line for what it created; this is the step people skip and
then blame the router for. Those six files sit in the working tree, and the
router classifies the working tree — only `.keel/` is excluded from the diff. Six
new files and ~115 lines is well past `quick_max_files: 1`, so the next two-line
fix routes to **standard** and asks for a plan. Commit first and it routes to
quick, which is the whole point.

What `init` writes, and whether it belongs in git:

| Path | Commit it? |
|---|---|
| `keel.config.yaml` | yes — it is the repo's policy |
| `upstream.lock` | yes — a template with no dependencies pinned yet |
| `CLAUDE.md` | yes — only the region between `<!-- keel:begin -->` and `<!-- keel:end -->` is managed |
| `.claude/settings.json` | yes — merged, never overwritten (`SUPERPOWERS_DISABLE_TELEMETRY=1`) |
| `.claude/agents/keel-reviewer.md` | yes |
| `.gitignore` | yes — `init` adds `.keel/` |
| `.keel/` | no, and it is not disposable either — see below |

`.keel/` is gitignored but **not** scratch. It holds `tdd-state.json` — the
per-branch record of which tests have been observed failing, so deleting it
re-blocks the next new exported symbol until you re-run its test and watch it
fail — the telemetry spool `keel doctor` reads, and `trust.json`, the record of
which repo-local pack rules you have approved. `.keel/cache/` alone is safe to
delete.

### Test layout

**No layout workaround is needed.** Gate 3 pairs a source file with its test by
convention — `src/tdd/pairing.ts`, no module graph, no type checker — and it is
deliberately over-generous, because a missed pairing weakens a gate while a
wrong one blocks correct work.

For `src/auth/refresh.ts` it will find, among others:

```
src/auth/refresh.test.ts          colocated
src/auth/__tests__/refresh.test.ts
tests/refresh.test.ts             flat
tests/auth/refresh.test.ts        first segment swapped
tests/src/auth/refresh.test.ts    whole path mirrored
```

The same four shapes apply under `test/`, `spec/` and `__tests__/`, with `.spec`
as well as `.test`, and `.tsx` as well as `.ts`. Python is the same with
`test_<name>.py` and `<name>_test.py`. Monorepo layouts are covered too:
`packages/api/tests/util/money.test.ts` pairs with
`packages/api/src/util/money.ts`.

If your layout is not on that list, the failure is quiet, not loud — gate 3 has
no test to check and stays silent rather than blocking. `tdd.test_globs` in
`keel.config.yaml` controls what counts as a test file in the first place.

### The commands

```bash
keel init      # writes keel.config.yaml + CLAUDE.md, installs agents. Idempotent.
keel check     # validates config, packs, phase ownership, upstream pins
keel route     # what track this change is on, and why
keel gate      # run the standards gates over the diff, outside the editing loop
keel trust     # review and approve repo-local pack rules before they run
keel doctor    # what is active, how fast it runs, how often gates fire
keel gotchas   # review gotcha candidates; nothing is written unconfirmed
keel spec      # full-track spec discipline: size cap, delta, archive gate
keel mutate    # diff-only mutation testing, gated on score
keel review    # assemble the review chain's input
keel upstream  # verify or install the pinned upstream set
```

---

## Modules

Each section is written for someone who has not seen the code before.

### `src/router` — track classification

Turns a diff into a track. `signals.ts` does the I/O (git diff, AST symbol
extraction, `git grep` caller counts); `classify.ts` is a pure function of those
signals with no clock, no filesystem and no LLM, so the same change always routes
the same way.

Four rules, in order:

1. A path matches `force_full_globs` → **full**.
2. A changed exported symbol has more external callers than
   `escalate_caller_threshold` → at least **standard**, or **full** if a caller
   is in a different package.
3. Small, single-file, no exported signature change → **quick**.
4. Otherwise **standard**.

Rules 1–2 set a floor; rules 3–4 pick a natural level; the result is the higher
of the two. That is what makes the router **escalate-only** — it never lowers a
track on its own. A developer can, with `--track`, and that is logged.

Symbol analysis is syntactic: one file, one parse, no type checker and no module
graph. Caller counting is `git grep -w`, which over-counts rather than
under-counts — being wrong in the direction of *more* process is the safe way to
be wrong. Results are cached under `.keel/cache/` keyed by content hash, so a
stale entry is unaddressable rather than merely unlikely.

**Cost:** the budget is 150 ms warm p95 on a 5,000-file repo. What
`tests/router/perf.test.ts` actually asserts is a *scaling ratio*, not a
millisecond figure — see [Performance](#performance) for why, and for how to get
a number for your own machine.

### `src/standards` — the packs

The extensibility mechanism, and the most important module here. A standard is a
folder:

```
standards/<name>/
  standard.yaml   required
  rule.ts         gate mode, TypeScript
  rule.py         gate mode, Python
  guide.md        guide mode
  rubric.md       review mode
```

Three modes: **`gate`** blocks and never enters the model's context; **`guide`**
surfaces a skill when the change touches matching paths and only ever suggests;
**`review`** contributes a rubric entry filtered to the touched paths.

Gates run in two places, on the same rules and the same diff-only evaluation: the
PostToolUse hook, while Claude Code is editing, and `keel gate` in CI. The second
is what covers a change written in another editor, by a bot, or by anyone
without the plugin installed — without it, org rules apply to some authors and
not others.

Adding a standard is a folder plus a PR — zero changes to `src/`. That is
enforced by a test which drops a brand-new pack into a temp directory and asserts
it fires.

Two properties the runner guarantees, so no pack author has to remember them:

- **Diff-only, always.** Findings on lines the change did not touch are dropped
  by the runner, whatever a rule returns. This is what makes gates survivable on
  a legacy repo.
- **A crash is not a block.** A rule that throws, fails to compile, or never
  resolves reports an error and lets the edit through. There is a 2-second
  per-rule timeout so a pathological pack cannot hang a hook.

Rules are authored in TypeScript and transpiled on demand via
`ts.transpileModule`, cached by content hash — no build step for pack authors.
They may only use `import type`, since transpilation is single-file.

Three reference packs ship as templates, one per mode:

- `no-raw-color-values` — `gate`, a real AST rule. It deliberately does *not*
  fire on hex in comments, anchors or commit SHAs, which is where a regex
  approach fails.
- `error-envelope` — `gate`, one standard covering both languages from a single
  `standard.yaml`.
- `migration-safety` — `review`, a `rubric.md` of the questions a migration has
  to answer. Reversible? Deployable ahead of the code? Lock duration? Backfill
  separated?

No `guide`-mode pack ships; see [What is not built](#what-is-not-built).

**Cost:** the budget is 200 ms p95 per file, warm. `tests/standards/perf.test.ts`
prints p50/p95 on every run and asserts only a catastrophic-regression ceiling —
see [Performance](#performance).

### `src/tdd` — the four gates

Unit-level only. `outer_loop: false` ships and is honoured; integration TDD is a
separate project.

1. **Test weakening** — compares the test file before and after. Blocks on
   assertions removed, tests deleted, matchers loosened (via an explicit
   per-framework downgrade map), or `skip`/`.only` added. Override with a
   `keel: allow-test-change <reason>` comment; the reason is required and is
   recorded.
2. **Mocking the unit under test** — mocking the module a test exists to
   exercise makes it pass without an implementation.
3. **Observed RED** — a new *exported* symbol needs a test that has been *seen*
   failing. State lives in `.keel/tdd-state.json`, per branch, and is driven by
   the `Bash` calls a developer already makes: write test, run it, watch it fail,
   implement. Work that way and you will never notice the gate. Existing symbols
   are untouched, so refactoring and bug-fixing are unaffected.
4. **Assertion lint** — no assertion-free tests, no snapshot-only assertions on
   logic, no truthiness-only assertions.

`tdd.exempt_globs` is honoured by all four. `KEEL_SPIKE=1` relaxes 1 and 3 for
exploratory work and records the session as a spike; it does not relax 2 or 4.

Zero false positives across this repository's own 400+ test suite — an assertion
in the test suite, not a claim. It found two real bugs in the gates when first
run.

### `src/context` — CLAUDE.md and gotchas

`keel init` generates a CLAUDE.md under 60 lines containing the repo's purpose,
**exact** build and test commands detected from `package.json` / `pyproject.toml`
/ `Makefile`, confirmed gotchas, and pointers to skills. It never emits facts
already visible in a config file: it will tell you the repo uses `make test`, not
that it uses vitest.

Only content between `<!-- keel:begin -->` and `<!-- keel:end -->` is managed, so
re-running init preserves hand-written sections.

The **gotcha scanner** proposes candidates from four signals: files with repeated
revert/hotfix history; comments carrying hard-won knowledge (`hack`,
`do not remove`, `careful`, `load-bearing`); modules nothing imports but
configuration names (the "looks dead but isn't" case); and anomalous coupling.
**Every candidate requires human confirmation.** The scanner proposes; it never
writes. An unreviewed gotcha is worse than none — it is a confident, permanent,
wrong instruction in the file the model trusts most.

### `src/spec` — full-track spec discipline

OpenSpec owns the design phase; Keel owns the discipline around it. Four rules
from the plan, three of them mechanical:

1. **Hand brownfield onboarding to OpenSpec** — `keel spec onboard` checks
   OpenSpec is installed and hands over to `/opsx:onboard` rather than
   reimplementing it. **Read the caveat before relying on this:** `/opsx:onboard`
   is a guided walkthrough of one small real change, not a pass that extracts
   specs from existing code, and it is **expanded-profile only** — on a default
   OpenSpec install the command is absent. Nothing in OpenSpec or Keel generates
   specs from a legacy service; specs accrete one change at a time. The
   `keel-spec` skill has the detail.
2. **Archive at merge, CI-gated.** On the default branch, a proposal marked
   `applied` that still sits outside `archive/` fails the build. That is what
   keeps specs current: the update happens at merge, not as a documentation
   chore nobody does.
3. **Cap spec size at ~250 lines per change**, counted across every markdown
   file in it. Over warns, far over fails — the plan says "~250", and failing a
   build over 251 lines teaches people to game the number rather than write
   less.
4. **Attach the delta to the PR.** `keel spec delta` renders the
   ADDED/MODIFIED/REMOVED sections as a PR comment, updated in place on each
   push. This is the adoption lever: once reviewers ask for the delta, authors
   write them without being told.

`keel spec new <id>` scaffolds *structure* — frontmatter, headings, delta
markers — and no content. Filler prose would be inventing spec content, which
is OpenSpec's job and the author's.

**EARS acceptance criteria** ship switched off. The plan says "try it on two
changes before deciding", so `spec.ears: true` turns on a validator that warns
and never blocks.

### `src/mutation` — mutation testing

Rule of the road 4: **mutation score, never coverage.** Coverage targets produce
tests that execute code without checking anything; a surviving mutant is direct
evidence of exactly that. This is also the stated catcher for TDD failure mode 4
— tautological assertions — which review and assertion lint cannot see.

A mutant is one AST-verified textual edit: a flipped comparison, a swapped
arithmetic operator, an emptied string, a nulled return. The runner writes it,
runs the repo's own test command, and restores the file. Tests failing means the
mutant was **killed**; tests passing means it **survived**.

Three properties it is built around:

- **Diff-only.** Mutants are confined to changed lines. Whole-file mutation on a
  legacy repo would never finish.
- **Deterministic.** Same diff, same mutants, same score — selection is sorted
  and strided, never random. A gate that varies run to run gets switched off.
- **Restore always.** The original is written back in a `finally` and verified
  afterwards. Leaving a mutated file behind would be worse than any missed
  finding.

The floor is `mutation.min_score`, default `0.5`. **Ratcheting it is a manual
decision and there is no report to make it from yet.** Each run writes a
`mutation` telemetry event carrying the score, and `src/telemetry/ship.ts`
exports a `mutationTrend()` helper over those events — but no command calls it.
`keel doctor` does not report mutation at all, and neither does
`keel telemetry show`. Until one of them does, ratcheting means reading
`.keel/telemetry/*.jsonl` yourself and editing `min_score` in a commit.

Nothing to mutate — a docs or config change — passes; that is not untested code.

CI only. This is minutes of work, not milliseconds. It runs on pull requests and
on pushes to the default branch, because mutation score stands in for coverage
here and a direct push is exactly the change nobody reviewed.

### `src/display` and `src/telemetry` — output

The **MessageDisplay formatter** compresses a message to four rows:

```
◆ auth token refresh
  changed   src/auth/refresh.ts, src/auth/refresh.test.ts
  verified  ✓ types  ✓ standards  ✓ tests 12/12  ✓ tdd
  decide    session TTL: 15m (assumed) — confirm or override
  next      run /code-review, then open PR
```

Display-only: the transcript and the model's context keep the original, so this
is safe to iterate on. Two rules govern it — never break the display (any doubt
returns nothing and the original renders), and **never drop a `decide` line**. If
the message states an assumption anywhere and it would not survive into the
output, the formatter renders nothing rather than a tidy summary that hides it.

**Measured:** p50 0.06 ms, p95 0.14 ms over 500 messages against a 100 ms
budget, reproduced on 2026-08-02 with
`npx vitest run tests/display/format.test.ts`. Three orders of magnitude of
headroom is why this one is safe to state as a number at all.

**Telemetry** is a local JSONL spool. Constraint: no network calls in hooks,
ever. The serialiser is the privacy control — each event kind is written field by
field from a fixed allowlist, so an unexpected field has no path to disk. Paths
are excluded too: not source code, but they leak product names. Asserted by test.

Events cover the plan's measures: track distribution, override rate and
direction, gate hit rates, TDD gate trips, mutation scores, and **PR comment
counts** — the headline success metric is "human PR comments down 40%", which
needs the number recorded somewhere. `keel review record` captures it from CI,
where the PR API is reachable; counts only, never bodies or authors.

### `python/keel_gates`

Standard library only. Two entry points, both JSON over stdin/stdout:
`keel_gates.symbols` (router symbols) and `keel_gates.run` (diff-only gate
runner). `keel_gates.tdd` backs the Python side of the TDD gates. Python cold
start is ~20 ms, so a subprocess per call is affordable.

---

## Performance

Budgets are fixed. **Three of these four rows carry no measured figure**, because
those measurements do not reproduce to a single number on a shared machine, and
publishing one anyway is how a README ends up lying. Run the command in the last
column and read your own.

| Path | Budget | What is actually checked | Reproduce it |
|---|---|---|---|
| Router classification (5,000 files) | 150 ms warm p95 | a scaling ratio: the 5,000-file repo must be < 6× the 20-file repo, measured moments apart in one process | `npx vitest run tests/router/perf.test.ts` |
| Gate runner, per file | 200 ms warm p95 | p50/p95 printed; only a 2,000 ms catastrophic-regression ceiling is asserted | `npx vitest run tests/standards/perf.test.ts` |
| MessageDisplay formatter | 100 ms p95 | p95 < 100 ms, asserted | `npx vitest run tests/display/format.test.ts` |
| Hook cold start (Keel's own cost) | 80 ms p50 above the spawn floor | reported in CI, **not gated** | `npm run bench:coldstart` |

**Why not one number per row.** Every one of these is wall clock on a shared
machine, and the spread is larger than the thing being measured:

- The router test's own comment records warm p95 ranging **59–182 ms** across
  six runs on unchanged code — a 3.1× spread against a threshold with 30%
  headroom. It failed 2 runs in 6 before it was changed to assert a ratio.
- The cold-start benchmark computes `own = p50 − spawnFloor`, one noisy number
  minus another. Three consecutive runs on identical code reported 3, 1 and 1
  hooks over budget, and the measured spawn floor itself moved 57 → 84 ms
  (47%). It is reported in CI and gates nothing until the methodology is fixed.
- Only the formatter has enough headroom — three orders of magnitude — for a
  figure to survive the noise. It is the one measurement stated as a number
  anywhere in this README, in `src/display`'s section above, and it was
  re-measured before being written down.

**Warm is not the whole cost, and cold is not small.** All the budgets above are
*warm*: compiler resident, rule already transpiled, cache populated. The first
AST parse in a process pays `import('typescript')` at roughly **400 ms**
(`docs/decisions.md` §1) and the router's per-commit cache under `.keel/cache/`
is empty on a fresh checkout, so a first run in CI or after `git clean` is
hundreds of milliseconds to low seconds, not tens. That is paid once per process
and never per file — hooks that only match paths, or that see a `.py` or `.md`
file, never load the compiler at all — but it is real and a cold number is what
a developer meets first.

This is why a flaky gate is treated as worse than a loose one throughout: a gate
that fails for reasons unrelated to the diff gets disabled, and a disabled gate
is no gate.

The single largest performance decision: **hooks never import zod.** Its module
init costs ~26 ms, paid on every tool call. The strict schema lives in
`config-schema.ts` for `keel check` and `keel init`; hooks use a coercing reader
in `config.ts`. A cross-check test runs the same corpus through both and asserts
identical output, so they cannot drift. This is exactly what build spec §0.9 asks
for — "fail loud at `keel init`, fail safe at runtime".

---

## Configuration

`keel.config.yaml`, created by `keel init`, validated against a JSON Schema
generated from the Zod schema (never hand-maintained alongside it) and written
to `.keel/keel.config.schema.json` for editor completion.

The file is **strict**: an unknown key is an error, not a warning, and
`keel check` names the field and the fix. Every key below is optional except
`version` and `repo` — omit a section and the defaults shown here apply.

`keel init` writes only the first six sections. The last four
(`upstream`, `display`, `spec`, `mutation`) are documented here and nowhere in
the generated file; they are live regardless, on the defaults shown.

```yaml
version: 1                              # config format version, not your release

repo:
  name: payments-api
  languages: [typescript, python]       # typescript | python

# --- written by `keel init` ---

tracks:                                 # reasoning effort per track
  quick:    { effort: low }             # low | medium | high | xhigh
  standard: { effort: medium }
  full:     { effort: high }

router:
  force_full_globs: ["**/migrations/**", "**/auth/**", "openapi/**"]
  quick_max_files: 1                    # above this, quick is not offered
  quick_max_lines: 50
  standard_max_files: 40                # above this, standard is not offered either
  standard_max_lines: 2000
  escalate_caller_threshold: 5          # more external callers escalates off quick
  package_roots: ["packages/*", "services/*", "apps/*"]   # what counts as a package boundary

standards:
  packs_ref: "keel-standards@0.1.0"     # pinned; `latest` is rejected
  disabled: []                          # pack names to switch off in this repo
  dirs: [standards]                     # where to look for packs

tdd:
  enabled: true
  outer_loop: false                     # integration TDD — off until a harness exists
  exempt_globs: ["**/*.config.ts", "**/migrations/**"]
  test_globs:                           # what counts as a test file
    - "**/*.test.ts"
    - "**/*.test.tsx"
    - "**/*.spec.ts"
    - "**/*.spec.tsx"
    - "**/*.test.js"
    - "**/*.spec.js"
    - "**/test_*.py"
    - "**/*_test.py"
    - "**/tests/**/*.py"

telemetry:
  sink: file                            # file | none
  path: ".keel/telemetry"

# --- defaults, not written by `keel init` ---

upstream:
  # Superpowers skills left on. Written to `skillOverrides` by `keel init` —
  # which does not affect plugin skills, and Superpowers is a plugin. See
  # "What is not built".
  enabled_skills:
    - test-driven-development
    - systematic-debugging
    - requesting-code-review
    - receiving-code-review
    - using-git-worktrees
    - subagent-driven-development
  disabled_skills: []

display:
  enabled: true                         # the four-row MessageDisplay formatter
  budget_ms: 100                        # 10–5000; formatting past this is dropped

spec:
  dir: openspec                         # OpenSpec's working directory
  max_lines: 250                        # per-change spec cap; over warns, far over fails
  ears: false                           # EARS acceptance criteria — warns, never blocks
  require_proposal_on_full: true        # full track needs a proposal

mutation:
  enabled: true
  min_score: 0.5                        # ratio 0–1; the gate's floor
  max_mutants: 40                       # per run
  timeout_ms: 120000                    # per mutant, minimum 1000
  test_command: ""                      # empty = detect from the repo
```

`mutation.test_command` is the one worth knowing about: leave it empty and Keel
detects the repo's test command, which is right nearly always and wrong exactly
when the detected command is slower or broader than the one you want run 40
times. Set it explicitly if `keel mutate` is timing out.

---

## Development

```bash
npm run verify           # every gating check, in the order CI runs them
npm run test             # vitest
npm run lint             # eslint over src, tests, build.mjs, scripts-dev
npm run bench:size       # bundle size, and the assertion that no hook imports zod
npm run bench:coldstart  # reported, not gated — see Performance
```

`npm run verify` deliberately excludes `bench:coldstart`, matching CI: it is a
noisy measurement, and having it in the middle of the chain meant a scheduler
outlier stopped the run before the Python checks ever executed.

`scripts/` is build output but **is committed**: Claude Code plugins are consumed
directly from a git checkout, with no install step that could run esbuild. CI
fails if the committed bundles differ from a fresh build.

---

## Upstream

```bash
keel upstream status              # what is pinned vs what is installed
keel upstream install             # run the recorded install commands
keel upstream install --dry-run   # show them without running them
```

Pinned in `upstream.lock`, resolved 2026-08-02 and checked for mutual
compatibility. `keel check` rejects any moving version (`latest`, `main`,
`^1.2.0`) and cross-checks every declared phase against the ownership map.

| Upstream | Version | Role | Owns |
|---|---|---|---|
| [Superpowers](https://github.com/obra/superpowers) | `6.2.0` | installed | planning, implementation |
| [OpenSpec](https://www.npmjs.com/package/@fission-ai/openspec) | `1.7.0` | installed | design, spec-conformance |
| [Spec Kit](https://github.com/github/spec-kit) | `0.15.1` | **pattern source** | — |

**Spec Kit is pinned but not installed, deliberately.** The plan takes two ideas
from it — the "constitution" concept and the extension/preset pattern copied for
standards packs — and nothing else. Its `/speckit.specify` and `/speckit.plan`
own *design* and *planning*, which OpenSpec and Superpowers already own here;
installing it would put two owners on both phases and fail the phase-ownership
check. Recording the version keeps the borrowed ideas traceable.

OpenSpec requires **node >=20.19.0**, which is why `engines.node` is `>=20.19.0`
rather than `>=20`. Spec Kit requires Python >=3.11, which `python/` already
does.

Outstanding: internal mirrors for the two installed dependencies. `keel check`
reports their absence as a warning, so the lock is usable now.

## Blocked inputs

| Input | Needed for | Current state |
|---|---|---|
| Org standards PDFs | migrating org rules to packs | Pack format, loader and gate runner are complete; only the three reference packs ship. |
| Component MCP server schema | M7 (UI bridge) | Not started. No speculative client was written. |

---

## What is not built

Called out plainly rather than left to be discovered.

| Not built | Why |
|---|---|
| **UI bridge (M7)** | Blocked on the component MCP server's tool schema. The build spec forbids writing a speculative client against a guessed one, so nothing was written. |
| **Org standards packs** | Blocked on the PDFs. The pack format, loader and gate runner are complete and three reference packs ship as templates — one per mode. |
| **A `guide`-mode reference pack** | Guide packs encode org-specific judgment, which is exactly what the PDFs carry. The format is documented in the `keel-standards` skill and covered by tests; inventing an org convention to have an example would be inventing policy. |
| **Integration TDD (`outer_loop`)** | Deferred by the plan, not by us. The config carries `outer_loop: false` and honours it; turning it on later is one config line plus a standards pack. |
| **Per-skill subsetting of Superpowers** | Not possible from settings. `skillOverrides` exists and Keel writes it, but Claude Code documents that it **does not affect plugin skills** — and Superpowers ships as a plugin. Its skills are managed whole-plugin through `/plugin`. This is a platform boundary, not a Keel gap, and `keel init` says so rather than writing settings that quietly do nothing. |
| **A mutation-score trend report** | `mutationTrend()` exists in `src/telemetry/ship.ts` and no command calls it. Neither `keel doctor` nor `keel telemetry show` reports mutation at all, so ratcheting `mutation.min_score` means reading the JSONL spool by hand. |
| **A gating hook cold-start benchmark** | The measurement subtracts two independently noisy numbers and cannot separate a regression from scheduler jitter. It runs in CI and reports; it does not fail a build. `docs/decisions.md` §3 says what fixing it needs. |
| **A published types package for pack authors** | There is no import specifier for `Finding`/`GateContext` that resolves outside this checkout. Rules are matched structurally and `import type` is erased, so declaring the shapes in the rule file costs nothing — but it is a workaround, not a design. |
| **Slash commands** | No `commands/` directory ships and `plugin.json` declares none. Everything is CLI, hooks, skills and one output style. |

## Policy decisions

**Nothing is in managed settings.** Every gate is overridable by the repo that
runs it, including the two that `docs/managed-settings.md` argues are safe to
lock. The case for waiting is simply that a gate a team can neither disable nor
satisfy gets routed around — a different tool, a copied file, the plugin
switched off — and that is a worse outcome than the gate not existing. Locking
something down should be earned with measured false-positive rates.

**Telemetry is on by default and never leaves your machine.** Events are JSONL
under `.keel/telemetry`; `keel telemetry show` reads them in place and
`keel telemetry ship` bundles them to the same disk. There is no remote sink and
no plan for one. It is on by default because opt-in would have sampled only the
teams already sold on Keel, which is the wrong population for judging which
gates are wrong. Set `telemetry.sink: none` to record nothing at all.

Both recorded in `docs/decisions.md` §16; the M9.4 recommendation that preceded
them is `docs/managed-settings.md`.

## Rules of the road

1. Quick track must be invisible.
2. Diff-only, always. Gates check changed lines, never whole files.
3. Mechanical beats written. If it can be a lint rule, it must be one.
4. Mutation score, never coverage. Coverage targets produce tests that assert
   nothing.
5. Red must be observed. A test never seen to fail proves nothing.
6. Delete rules that don't fire. Quarterly; the default is removal.
7. Compose, don't fork. Pin upstream, mirror internally, never patch.
8. One owner per phase — checked at `keel check`, which fails loudly on a
   conflict and names both claimants.
