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
style are Claude Code components `keel init` installs into your repository, and
there is no CLI-only mode that reproduces in-loop enforcement. On Cursor, Copilot, Aider or a bare terminal, none of it
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

Two steps: get the `keel` CLI onto your PATH, then run `keel init` in a
repository. **There is no marketplace and no `/plugin install`.** You already
have the source — cloning it is how you get the CLI — so `init` installs the
hooks, skills and output style straight from that checkout into the
repository's own `.claude/`.

### 1. The CLI

Keel is not on npm: `package.json` is `private: true` while it is internal.

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

### 2. `keel init` in your repository

```bash
cd your-repo
keel init
```

That writes four things Claude Code discovers on its own:

| What | Where | Scope |
|---|---|---|
| hooks | `.claude/settings.local.json` | yours only — see below |
| skills | `.claude/skills/<name>/SKILL.md` | committed |
| output style | `.claude/output-styles/keel.md` | committed, off until you select it |
| the reviewer subagent | `.claude/agents/keel-reviewer.md` | committed |

Then `/reload-plugins` — or just start a new session — and check it took: a new
session should open with Keel's process notes injected. That is the SessionStart
hook, and it is the cheapest proof the wiring is live.

**Everyone on the team runs `keel init` once.** The hook commands name an
absolute path to *your* Keel checkout, and yours is not where a teammate put
theirs, so that wiring goes to `.claude/settings.local.json` — the per-developer
scope Claude Code already provides — and `init` adds it to `.gitignore`.
Everything shared travels through git: `keel.config.yaml`, `CLAUDE.md`, the
packs, the skills. Only the pointer to your own checkout is local.

`init` never clobbers a hook you wrote. It replaces its own entries and leaves
the rest, so running it after a `git pull` picks up a changed hook set without
touching anything of yours.

---

## Setting up a repository

```bash
cd your-repo
keel init
git add keel.config.yaml upstream.lock .gitignore CLAUDE.md \
        .claude/settings.json .claude/skills/ .claude/output-styles/ .claude/agents/
git commit -m "chore: keel init"
keel check         # validates config, packs, phase ownership, upstream pins
keel doctor        # what is active, how fast it runs, how often gates fire
```

**Commit what `keel init` writes before you make another change.** `init` prints
the exact `git add` line for what it created; this is the step people skip and
then blame the router for. Those six files sit in the working tree, and the
router classifies the working tree — only `.keel/` is excluded from the diff. Six
new files and roughly 200 lines is well past `quick_max_files: 1`, so the next
two-line fix routes to **standard** and asks for a plan. Commit first and it
routes to quick, which is the whole point.

What `init` writes, and whether it belongs in git:

| Path | Commit it? |
|---|---|
| `keel.config.yaml` | yes — it is the repo's policy |
| `upstream.lock` | yes — a template with no dependencies pinned yet |
| `CLAUDE.md` | yes — only the region between `<!-- keel:begin -->` and `<!-- keel:end -->` is managed |
| `.claude/settings.json` | yes — merged, never overwritten (`SUPERPOWERS_DISABLE_TELEMETRY=1`) |
| `.claude/skills/` | yes — the three Keel skills |
| `.claude/output-styles/keel.md` | yes — available to everyone, active for nobody until they select it |
| `.claude/agents/keel-reviewer.md` | yes |
| `.gitignore` | yes — `init` adds `.keel/` and `.claude/settings.local.json` |
| `.claude/settings.local.json` | **no** — it names an absolute path to your own Keel checkout |
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
keel telemetry # show, bundle or clear the local event spool
```

That is the whole surface, plus `keel version` and `keel help`. The help screen is
rendered from the same table every flag is validated against
(`src/cli/registry.ts`), so the two cannot drift, and `keel <command> --help`
lists that command's flags. An unknown flag or subcommand is an error naming what
the command does accept —
`keel route --trak full` used to exit 0 having ignored the typo, leaving a
developer believing they had overridden the track.

---

## Continuous integration

**This is not optional, and it is the part adopters skip.** `keel gate`,
`keel spec check` and `keel mutate` are the enforcement story for everyone who is
not editing inside Claude Code — another editor, a bot, a web edit, a direct
push — and `keel spec check` in CI is where the process gates that matter
(full-track proposals, the spec cap, the archive rule) are actually enforced. A
repository that installs Keel and wires up no CI has the router's advice, the
skills, and nothing that stops anything.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is the worked example —
Keel's own CI is these jobs, so they are tested every time this repository
builds. The minimum shape is small:

```yaml
jobs:
  keel:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # every gate diffs; a shallow clone has no base
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci

      # Keel is not on npm while it is internal, so CI installs it the same way
      # you did: from a checkout. Clone it outside the workspace so it is not
      # part of the repository under test, and pin the commit — no releases are
      # tagged yet, and a gate that changes under you is not a gate.
      - name: Install the keel CLI
        run: |
          git clone https://github.com/KirtiJha/keel "$RUNNER_TEMP/keel"
          git -C "$RUNNER_TEMP/keel" checkout <commit-sha>
          (cd "$RUNNER_TEMP/keel" && npm ci && npm run build && npm link)

      - name: keel gate and keel mutate
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            base="origin/${{ github.base_ref }}"
          elif git rev-parse --verify --quiet "${{ github.event.before }}^{commit}" >/dev/null; then
            base="${{ github.event.before }}"
          elif git rev-parse --verify --quiet "HEAD^" >/dev/null; then
            base="HEAD^"
          else
            echo "root commit — no base to diff against, nothing to gate"
            exit 0
          fi
          keel gate   --against "$base" --trust-repo-rules
          keel mutate --against "$base"

      - name: keel spec check
        run: |
          if [ "${{ github.ref }}" = "refs/heads/main" ]; then
            keel spec check --default-branch
          else
            keel spec check
          fi
```

If you would rather not `npm link`, `node "$RUNNER_TEMP/keel/scripts/cli.mjs"`
is the same program — `bin/keel.mjs` is a thin shim over exactly that.

Four things in there are not obvious.

**On a push, the base ref is `github.event.before`, not `HEAD^`.** They agree for
a merge commit and for a squash, which is why the mistake survives review — but a
rebase-merge fast-forwards N commits at once, and `HEAD^` then names the
second-to-last of them. Everything before it was never gated and never mutated.
On a pull request the base is `origin/${{ github.base_ref }}`, which is why
`fetch-depth: 0` is not optional: both gates diff, and a shallow clone has
nothing to diff against.

**`keel gate` needs `--trust-repo-rules` in CI.** A repo-local pack rule runs
only after a human approves it (see [the trust boundary](#a-repo-local-pack-rule-is-code-and-runs-only-after-approval)),
and a runner cannot approve anything: the approval is signed under a machine-local
key that does not survive the job. Without the flag, `keel gate` reports every
repo-local pack as unapproved, exits 1, and advises a machine to run
`keel trust add` — advice it cannot take, so the gates would be reachable from CI
in name only. The flag is safe *here specifically*, because the job has already
checked the repository out and is already running its code: `npm ci` runs its
install scripts, `npm test` runs its tests. A pack rule is not a new privilege on
a runner. It is a flag rather than a `CI=true` sniff because environments set
`CI` for all sorts of reasons, and a boundary that disables itself on a variable
someone else controls is not a boundary. **Do not put it in a local alias or a
shell function** — that is the one place it takes the boundary away.

**`--default-branch` is what turns on the archive rule.** Locally `keel spec
check` infers the default branch from its name (`main`, `master`, `trunk`), but
`actions/checkout` leaves a detached HEAD, so `git rev-parse --abbrev-ref HEAD`
answers `HEAD` and the inference never fires. On the default branch it has to be
told. That rule — a proposal marked `applied` still sitting outside
`archive/` fails the build — is what keeps specs current, and it is the reason
`keel spec check` in CI is where the process gates actually bite.

**Separate jobs beat one job.** The example above is a single job for brevity; in
`.github/workflows/ci.yml` these are `standards-gates`, `mutation` and
`spec-discipline`, because a failing `keel gate` in one step hides whatever
`keel mutate` would have said in the next.

Two more jobs are worth copying from the same file: `keel spec delta` posting the
change delta as a PR comment — which needs `pull-requests: write` **on that job
and nothing else**, and note that a job declaring `permissions` *replaces* the
workflow default rather than adding to it, so `contents: read` has to be repeated
— and `keel review record`, which feeds PR comment counts into telemetry from the
one place the PR API is reachable.

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
They may only use `import type`, since transpilation is single-file. The compiled
artifact under `.keel/cache/packs/` carries a stamp binding it to the source hash
under a machine-local key, so a committed cache entry cannot stand in for the
`rule.ts` a reviewer actually read.

#### A repo-local pack rule is code, and runs only after approval

A pack's `rule.ts` / `rule.py` is imported and executed **in-process**, with the
full privileges of the session — any file, any subprocess, the network. Nothing
about the pack format sandboxes it. That is fine for the packs that ship inside
the plugin: they arrive with Keel and are trusted by construction. It is not fine
for a pack found in the repository being edited, and `standards.dirs` defaults to
`["standards"]` — so cloning an untrusted repo, opening it, and letting Claude
edit one matching file was enough to run that repo's code, with no config and no
prompt.

So a repo-local rule runs only after an explicit approval:

```bash
keel trust list           # what will not run, where it lives, what it hashes to
keel trust add <pack>     # approve it — read the file first
keel trust remove <pack>  # revoke
```

Three properties are worth knowing before you rely on it:

- **Approval is keyed to the exact bytes.** Editing an approved rule invalidates
  it and you approve again. Trust is in the content, never in the path.
- **A repository cannot approve itself.** Records live in `.keel/trust.json`,
  which is gitignored, and each carries an HMAC under a random key stored outside
  every repository (`KEEL_HOME`, or `~/.keel/machine-key`). A committed
  `trust.json` does not verify. Trust is per checkout.
- **An unapproved pack "did not run"; it never "passed".** `keel gate` exits
  non-zero on one and `keel doctor` reports it. Failing to decide never blocks an
  edit, though — hooks fail open, so the cost of an unapproved rule is a silent
  gate, not a stopped developer. If a pack you just wrote produces no findings
  and no errors, check this first.

**In CI, pass `keel gate --trust-repo-rules`.** A runner cannot approve anything,
and the approval it would need is signed under a key that does not survive the
job. See [Continuous integration](#continuous-integration) for why that is safe
there and nowhere else.

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
`mutation` telemetry event carrying the score, so the data is on disk — but
nothing reads it back: `keel doctor` does not report mutation at all, and neither
does `keel telemetry show`. A `mutationTrend()` helper existed in
`src/telemetry/ship.ts` with no caller and was deleted rather than left to make
the feature look shipped. Until a command reports the trend, ratcheting means
reading `.keel/telemetry/*.jsonl` yourself and editing `min_score` in a commit.

Nothing to mutate — a docs or config change — passes; that is not untested code.
**Nothing it could run**, though, is a failure: a repo whose test command cannot
be detected gets an error, not a score of 1.

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

The file is **strict at every level**: an unknown key is an error, not a warning,
and `keel check` names the section, the field and the fix. Nested strictness is
the half that matters — every knob a team actually touches lives inside a
section, and `router.quick_max_flies: 3` used to validate clean and silently run
the default. Every key below is optional except `version` and `repo` — omit a
section and the defaults shown here apply.

**`keel init` writes all ten sections, every key at its default**, each with the
comment that explains the knob — 109 lines. It wrote six of them for a while, and
`mutation.test_command` was discoverable only from the error message you got when
mutation testing could not find a test command. Deleting a field from the
generated file is safe: it falls back to exactly the value that was there.
`.keel/keel.config.schema.json`, regenerated from the Zod schema on every `keel
init`, is the authority on what the file accepts; this section is the authority
on what the values mean.

```yaml
version: 1                              # config format version, not your release

repo:
  name: payments-api
  languages: [typescript, python]       # typescript | python

tracks:                                 # reasoning effort per track
  quick:    { effort: low }             # low | medium | high
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
  dirs: [standards]                     # a rule found here is repo-local: needs `keel trust add`

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
npm run verify           # typecheck, lint, build, test, bundle size, then the Python three
npm run test             # vitest
npm run lint             # eslint over src, tests, build.mjs, scripts-dev
npm run bench:size       # bundle size, and the assertion that no hook imports zod
npm run bench:coldstart  # reported, not gated — see Performance
```

**`verify` is not all of CI, and a green `verify` can still go red on five
checks.** It runs `typecheck → lint → build → test → bench:size → py:lint →
py:types → py:test`, and that is the whole list. What CI runs on top of it:

| Also in CI | Why `verify` cannot cover it |
|---|---|
| committed bundles match a fresh build (`git diff --quiet -- scripts/`) | `verify` runs the build; it does not check whether you committed the result |
| `keel mutate --against <base>` | minutes of work against a base ref, not seconds against a working tree |
| `keel spec check` (`--default-branch` on `main`) | the archive rule only means something at merge |
| `keel gate --against <base> --trust-repo-rules` | needs a base ref, and the trust opt-out that only makes sense on a runner |
| `keel check` | dogfooding: Keel validating its own config, packs, phase ownership and pins |

The last four are Keel run on Keel, and they are the ones a local `verify` never
touches. `npm run coverage` and `npm run bench:coldstart` also run in CI and gate
nothing — coverage because rule of the road 4 is mutation score, never coverage,
and cold start because the measurement is too noisy to gate on
(see [Performance](#performance)). `verify` deliberately excludes
`bench:coldstart` for the same reason CI does not gate on it: having it in the
middle of the chain meant a scheduler outlier stopped the run before the Python
checks ever executed.

`scripts/` is build output but **is committed**: Claude Code plugins are consumed
directly from a git checkout, with no install step that could run esbuild. CI
fails if the committed bundles differ from a fresh build.

The full workflow is [`.github/workflows/ci.yml`](.github/workflows/ci.yml);
[Continuous integration](#continuous-integration) explains the parts a repository
adopting Keel should copy.

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
| [Superspec](https://www.npmjs.com/package/@sbswang2002/superspec) | `0.1.11` | **pattern source** | — |

Four pins, two installed. `keel check` prints all four.

**Superspec's identification is unconfirmed, and the lock file says so.** npm
carries about ten packages named some variant of "superspec". This one is pinned
because its description — "OpenSpec + Superpowers workflow bootstrapper for
Claude Code" — matches the plan's wording exactly, and the single thing the plan
takes from it is that wiring: *OpenSpec plans, Superpowers builds*. That wiring
is already implemented as Keel's own phase-ownership map in
`src/upstream/phases.ts`, so installing a third workflow tool on top of it would
put a second owner on planning. It installs nothing, which is why the pin is
recorded despite the doubt: a wrong pin costs a wrong citation and nothing else.
Correct it if a different project was meant.

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
| **A mutation-score trend report** | Every run spools a `mutation` event with its score, and nothing reads them back: neither `keel doctor` nor `keel telemetry show` reports mutation at all, so ratcheting `mutation.min_score` means reading the JSONL spool by hand. A `mutationTrend()` helper existed with no caller and was deleted — an export nothing calls is a promise nothing keeps. |
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
