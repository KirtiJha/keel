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

**A quick change must feel like no process at all.** If a two-line fix feels
slower with Keel than without it, the router is wrong — that is a bug, not a
tuning exercise.

---

## Quick start

```bash
npm install
npm run verify          # typecheck, lint, build, test, benchmarks, python
node scripts/cli.mjs init
```

In a target repository:

```bash
keel init      # writes keel.config.yaml + CLAUDE.md, installs agents. Idempotent.
keel check     # validates config, packs, phase ownership, upstream pins
keel route     # what track this change is on, and why
keel doctor    # what is active, how fast it runs, how often gates fire
keel gotchas   # review gotcha candidates; nothing is written unconfirmed
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

**Measured:** warm p95 **39 ms** on a 5,000-file repo (budget 150 ms).

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

Three modes: **`gate`** blocks in a hook and never enters the model's context;
**`guide`** surfaces a skill when the change touches matching paths and only ever
suggests; **`review`** contributes a rubric entry filtered to the touched paths.

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

Two reference packs ship as templates: `no-raw-color-values` (real AST rule; it
deliberately does *not* fire on hex in comments, anchors or commit SHAs, which is
where a regex approach fails) and `error-envelope` (one standard, both languages,
sharing one `standard.yaml`).

**Measured:** gate runner p95 **31 ms** per file (budget 200 ms).

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

### `src/display` and `src/telemetry` — output

The **MessageDisplay formatter** compresses a message to four rows:

```
◆ auth token refresh
  changed   src/auth/refresh.ts, src/auth/refresh.test.ts
  verified  ✓ types  ✓ standards  ✓ tests 12/12  ✓ tdd
  decide    session TTL: 15m (assumed) — confirm or override
  next      run /verify, then open PR
```

Display-only: the transcript and the model's context keep the original, so this
is safe to iterate on. Two rules govern it — never break the display (any doubt
returns nothing and the original renders), and **never drop a `decide` line**. If
the message states an assumption anywhere and it would not survive into the
output, the formatter renders nothing rather than a tidy summary that hides it.

**Measured:** p95 **0.1 ms** over 500 messages (budget 100 ms).

**Telemetry** is a local JSONL spool. Constraint: no network calls in hooks,
ever. The serialiser is the privacy control — each event kind is written field by
field from a fixed allowlist, so an unexpected field has no path to disk. Paths
are excluded too: not source code, but they leak product names. Asserted by test.

### `python/keel_gates`

Standard library only. Two entry points, both JSON over stdin/stdout:
`keel_gates.symbols` (router symbols) and `keel_gates.run` (diff-only gate
runner). `keel_gates.tdd` backs the Python side of the TDD gates. Python cold
start is ~20 ms, so a subprocess per call is affordable.

---

## Performance

Measured in CI, never assumed.

| Path | Budget | Measured |
|---|---|---|
| Router classification (5,000 files) | 150 ms | **39 ms** warm p95 |
| Gate runner, per file | 200 ms | **31 ms** p95 |
| MessageDisplay formatter | 100 ms | **0.1 ms** p95 |
| Hook cold start (Keel's own cost) | 80 ms | **32–73 ms** p50 |

Hook cold start is gated on **p50** with p95 reported. On a shared runner p50 is
stable to ~3 ms across runs while p95 swings ~30 ms on scheduler outliers; gating
on p95 would fail builds for reasons unrelated to the diff, and a flaky gate gets
disabled, which leaves no gate at all.

The single largest performance decision: **hooks never import zod.** Its module
init costs ~26 ms, paid on every tool call. The strict schema lives in
`config-schema.ts` for `keel check` and `keel init`; hooks use a coercing reader
in `config.ts`. A cross-check test runs the same corpus through both and asserts
identical output, so they cannot drift. This is exactly what build spec §0.9 asks
for — "fail loud at `keel init`, fail safe at runtime".

---

## Configuration

`keel.config.yaml`, created by `keel init`, validated against a JSON Schema
generated from the Zod schema (never hand-maintained alongside it).

```yaml
version: 1
repo:
  name: payments-api
  languages: [typescript, python]
tracks:
  quick:    { effort: low }
  standard: { effort: medium }
  full:     { effort: high }
router:
  force_full_globs: ["**/migrations/**", "**/auth/**", "openapi/**"]
  quick_max_files: 1
  quick_max_lines: 50
  escalate_caller_threshold: 5
standards:
  packs_ref: "keel-standards@1.0.0"
  disabled: []
tdd:
  enabled: true
  outer_loop: false          # integration TDD — off until a harness exists
  exempt_globs: ["**/*.config.ts", "**/migrations/**"]
telemetry:
  sink: file
  path: ".keel/telemetry"
```

---

## Development

```bash
npm run verify        # everything, in the order CI runs it
npm run test          # vitest
npm run bench:coldstart
npm run bench:size
```

`scripts/` is build output but **is committed**: Claude Code plugins are consumed
directly from a git checkout, with no install step that could run esbuild. CI
fails if the committed bundles differ from a fresh build.

---

## Upstream

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
| Telemetry destination | shipping telemetry | Local spool and `file` sink work; `keel telemetry ship` writes a local bundle only. |
| Org standards PDFs | migrating org rules to packs | Pack format, loader and gate runner are complete; only the two reference packs ship. |
| Component MCP server schema | M7 (UI bridge) | Not started. No speculative client was written. |

---

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
