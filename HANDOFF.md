# Keel — handoff

Written at commit `42bbaf6`, which is also `origin/main`. Everything described
here is on `main`; nothing is stranded on a branch.

This is a status document for picking the work up in Claude Code on the desktop.
It is deliberately blunt about what is unfinished and what surprised us, because
the failure mode this project kept hitting was *believing a mechanism was wired
up when it was not*.

---

## 1. What Keel is, in one paragraph

A CLI plus a set of Claude Code components that decide how much process a change
needs, then enforce standards and TDD while the code is being written. Three
tracks (quick / standard / full) picked deterministically from the git diff.
Standards live in "packs" — a folder with a YAML manifest and an optional
executable rule. Four TDD gates run in the PostToolUse hook. Mutation score
replaces coverage. Everything is diff-only: a finding on a line the change did
not touch is dropped, in one place, so a pack author cannot opt out.

**Scope, stated up front:** Claude Code only, TypeScript and Python only.

---

## 2. Current state

| | |
|---|---|
| Branch | `main` = `claude/build-end-to-end-gosunq` = `42bbaf6` |
| Tests | 944 TypeScript (31 files) + 60 Python |
| Typecheck / lint | clean |
| `keel check` on itself | exit 0, 3 warnings (all expected — see §6) |
| `keel gate` on itself | exit 0 |
| Source | 81 `src/*.ts`, 33 `tests/*.ts`, 10 `python/*.py` |
| Commands | 13 |
| Decisions recorded | `docs/decisions.md`, 17 entries |

**Verified toolchain here:** Node v22.22.2, npm 10.9.7, Python 3.11.15.
`package.json` requires Node `>=20.19.0`. CI pins `pytest==9.0.2`,
`ruff==0.15.8`, `mypy==1.19.1`.

```bash
npm ci && npm run build && npm run verify
```

`verify` = typecheck → lint → build → test → bundle-size → py:lint → py:types →
py:test. It deliberately does **not** run `bench:coldstart` (too noisy to gate,
see §6) and does not run the four Keel-on-Keel CI gates.

---

## 3. First thing to do on the desktop

```bash
git clone <repo> && cd keel
npm install
npm run build          # scripts/ is committed but rebuild after any pull
npm link               # puts `keel` on PATH
cd /some/other/repo && keel init
```

**There is no marketplace.** `keel init` is the install. It writes:

| What | Where | Committed? |
|---|---|---|
| hooks | `.claude/settings.local.json` | **no** — gitignored |
| skills | `.claude/skills/<name>/SKILL.md` | yes |
| output style | `.claude/output-styles/keel.md` | yes, inactive until selected |
| reviewer subagent | `.claude/agents/keel-reviewer.md` | yes |
| config, lock, CLAUDE.md | repo root | yes |

**The hook paths are absolute to your checkout**, which is why they go to the
*local* settings file. Consequence: every developer runs `keel init` once per
repo. Everything shared travels through git; only the pointer to your own
checkout is local.

`npm run build` after a `git pull` is not optional if `src/` moved — the hooks
execute the committed bundles in `scripts/`, not the TypeScript.

---

## 4. Two behaviours that will surprise you

### 4.1 A repo-local pack rule will not run until you approve it

A pack rule found in the repository being edited is unsandboxed code executed
in-process by the hook. It now requires explicit approval:

```bash
keel trust list            # what is waiting, with file path and hash
keel trust add <pack>      # after reading the file
```

Approval is keyed to the exact bytes, signed with an HMAC under a machine-local
key at `~/.keel/machine-key` (override with `KEEL_HOME`). Editing an approved
rule invalidates it. A repo cannot approve itself by committing `.keel/trust.json`.

Packs shipped inside the Keel checkout are trusted by construction.

**In CI** nobody can approve anything, so the workflow passes
`keel gate --trust-repo-rules`. The reasoning: a CI job has already checked the
repo out and is already running its code, so a pack rule is not a new privilege
there. On your laptop it is, which is why it is not the default.

### 4.2 The router is deterministic but nothing invokes it

`keel route` is a read. The SessionStart hook injects a reminder that tracks
exist; no hook runs the router, because counting callers with `git grep` on
every Write would cost more than every other gate combined. The classification
is a pure function of the diff — same change, same track, always — but *running*
it is the model's choice. The process gates that actually bite are in CI.

---

## 5. What is genuinely pending

Ranked. None of these is a defect; they are unbuilt or undecided.

### 5.1 Blocked on you

- **Org standards packs.** Three reference packs ship as templates (one per
  mode). Migrating real org rules needs the source material.
- **UI bridge (M7).** Not started. Blocked on the component MCP server's tool
  schema; no speculative client was written.
- **Internal mirrors** for superpowers and openspec — the 2 warnings `keel check`
  reports. Warnings, not errors, so the lock is usable.

### 5.2 Worth doing, small

- **`.claude/settings.local.json` holds an absolute path.** If you want a
  committed relative path instead, that needs checking against how Claude Code
  resolves a hook's cwd — I did not verify it and did not want to guess.
- **The CI recipe for getting the CLI onto a runner is unverified.** It is the
  one claim in the README nobody could execute here (no real GitHub runner). It
  ships with a no-link alternative and a `<commit-sha>` placeholder — the repo
  has no tags.
- **`scripts-dev/bench-coldstart.mjs` methodology.** It computes
  `own = p50 − spawnFloor`, one noisy number minus another; the floor moved
  57→84 ms across three identical runs. It reports instead of gating. To re-gate
  it: interleave the floor and hook samples so drift cancels, and decide on a
  statistic with a confidence interval rather than one p50 point.

### 5.3 Strategic — decide before building more

These came out of a competitive review against Spec Kit, OpenSpec and
Superpowers, and they are judgement calls, not bugs:

- **`src/spec` is ~875 lines re-deriving state OpenSpec already emits as JSON**
  (`show --json --deltas-only`, `list --json`, `validate --strict`). It hardcodes
  OpenSpec's markdown heading format as a regex. Rule of the road 7 is "compose,
  don't fork" — this is the largest violation of it in the codebase. Keel's
  genuinely-new spec rules are only three: CI archive-at-merge, the ~250-line
  cap, the PR-comment upsert. The rest could shell out.
- **`standards.packs_ref` has nothing behind it.** No registry, no
  `keel standards add`, no versioning. Org-wide rollout — the stated purpose —
  has no mechanism. Spec Kit's catalog model is the nearest prior art.
- **No spec↔code conformance check.** Spec Kit has `/analyze`, OpenSpec has
  `/opsx:verify`. Keel is better placed than either to do it mechanically: it
  already holds the diff, the changed exported symbols, and the parsed delta.
  "This change's delta claims ADDED `refreshToken`; no exported symbol by that
  name was added" is a gate the competitors can only ask a model to perform.
- **Zero slash commands.** Spec Kit ships 10, OpenSpec 12. Keel ships skills
  only. `/keel:route`, `/keel:why`, `/keel:delta` would be cheap.
- **`keel doctor` collides by name with `openspec doctor`** in any composed
  install.

### 5.4 The structural blind spot

Keel is its own plugin, so `pluginRoot === repoRoot` in this repo and every pack
here counts as shipped-with-Keel. **Its own CI therefore only ever exercises the
*trusted* pack path.** The untrusted path — what every consumer repo hits on a
fresh clone — is covered by tests now (`tests/cli/cli.test.ts`, "a consumer
repository, with no machine key of its own") but is not exercised by dogfooding.

This is exactly how "`keel gate` fails every consumer build with advice a runner
cannot take" survived an entire review pass. When you change anything about
trust, packs or `gate`, test it in a repo that is **not** this one.

---

## 6. Things that look wrong and are not

Save yourself the investigation:

- **`keel check` reports 3 warnings.** Two are missing internal mirrors; one is
  openspec pinned but not installed in this checkout. All expected.
- **`hook-performance` CI job is `continue-on-error`.** Deliberate — see §5.2.
- **`bench:coldstart` is not in `npm run verify`.** Deliberate: it used to sit
  mid-chain, so a timing flake skipped the entire Python suite.
- **Perf tests assert a ratio, not milliseconds.** `npm test` is the oracle
  `keel mutate` uses to decide whether a mutant was killed, so a flaky timing
  assertion inflates the mutation score. The router benchmark measures a 20-file
  and a 5,000-file repo in the same process and bounds the ratio; machine noise
  cancels.
- **`.keel/` is gitignored but not scratch.** It holds `tdd-state.json`
  (observed-RED history — deleting it re-blocks you), the telemetry spool, and
  `trust.json`. Only `.keel/cache/` is safe to delete.
- **`upstream.lock` pins four dependencies but only installs two.** superspec and
  spec-kit are `role: pattern-source` — pinned for provenance, never installed,
  own no phase. superspec's identification is explicitly unconfirmed in the lock.

---

## 7. Invariants — do not break these

Each one was violated at some point and each violation was a real bug.

1. **A hook never exits 1.** Claude Code treats 1 as non-blocking, so using it
   for policy silently turns a gate into a no-op. 2 blocks, 0 proceeds.
2. **A hook fails open.** Not just on a throw — on *degradation*. The worst bug
   found was `changedLines` answering "git could not tell us" with "every line is
   new", which blocked edits to committed, unmodified files whenever git was
   missing or the file was gitignored.
3. **Diff-only, always.** Enforced in the runner after the rule returns, and
   again in `run.py`. A pack author cannot opt out.
4. **A gate that did not run is never reported as a gate that passed.**
   `GateRunSummary.health` carries this; the hook and `keel gate` both consume it.
5. **Redaction at the choke point.** `emitAndExit` for hooks, `out`/`errOut` in
   `src/cli/output.ts` for the CLI. Never per-call-site — that is how it ended up
   covering one path of four.
6. **No network calls inside hooks.** Telemetry is a local JSONL spool; shipping
   is a separate command that writes to the same disk.
7. **`npm run build` before testing hooks.** The tests spawn the committed
   bundles, not the TypeScript.

---

## 8. Where to read next

| File | Why |
|---|---|
| `README.md` | install, scope, CI section, config reference |
| `CHANGELOG.md` `[Unreleased]` | **read the Security section first** — the trust boundary changes behaviour |
| `docs/decisions.md` | 17 entries, each explaining why something is the way it is |
| `docs/managed-settings.md` | the M9.4 recommendation; answered "nothing managed in v1" |
| `src/standards/trust.ts` | the trust model, in full, in the module header |
| `src/shared/git.ts` | `changedLines` — the fail-open contract, with the bug it fixes |
| `tests/hooks/gate-integrity.test.ts` | the properties that were true but unguarded |

---

## 9. Honest notes on how this was built

Two full review passes with parallel reviewers, every finding reproduced before
it was fixed. The recurring failure was always the same shape: **a mechanism
proven in isolation and assumed to be connected everywhere.** Redaction worked
and reached one egress path of four. Diff-only worked and was bypassed whenever
git was. `isInsideRepo` was written, documented, and never called.

Two findings worth remembering because they are the kind that hide:

- **Three source files contained raw NUL bytes**, making them binary to git — so
  every diff-only gate Keel ships was structurally blind to them. In a tool whose
  second rule is "diff-only, always". They are fixed; the lesson is that
  `git grep -I` will tell you if it happens again.
- **A test named "blocks a Python test that patches its own module" asserted the
  opposite.** The gate had never worked in Python and the test pinned the bug.

If you add a gate or a check, add the test that *would fail if you deleted it*.
An audit here deleted the fail-open logic and the mutation-gate wiring and the
suite stayed green both times; that is what `tests/hooks/gate-integrity.test.ts`
now prevents.
