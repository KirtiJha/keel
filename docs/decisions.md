# Decisions

Where the build spec was ambiguous, wrong, or silent — what was decided and why.
Build spec §5 asks for this, and §5.5 invites arguing a case rather than
complying with it.

---

## 1. The TypeScript compiler API cannot run inside a hook budget

**Spec:** M3 — "Symbol analysis: TypeScript via the compiler API." §0.5 —
`PreToolUse`/`PostToolUse` hooks p95 < 200 ms.

**Problem:** these cannot both hold. Measured on Node 22:

```
import('typescript')          ~400 ms
ts.createSourceFile + walk    ~13 ms
bare node process spawn       ~22 ms
```

The compiler's module init alone is 2× the entire hook budget.

**Also worth recording:** the 200 ms figure is self-imposed. Claude Code gives
`command` hooks a **600-second** default timeout, configurable per handler;
only `MessageDisplay` (10 s) and `UserPromptSubmit` (30 s) are lower. There is no
platform constraint anywhere near 200 ms.

**Decided** (with the maintainer, who chose it over three alternatives): keep the
real compiler API, load it lazily, and pay for it only when a gate genuinely
needs an AST. `typescript` is `external` in every bundle and imported through
`src/shared/ast/ts.ts`. A hook that only matches paths, or that sees a `.py` or
`.md` file, pays nothing.

**Rejected:** a bespoke lexer (a second parser to maintain, two analysis paths
that must agree); moving all AST work to `keel check`/CI, as Spec Kit and
OpenSpec do (neither registers hot-path hooks at all — but that would make gates
advisory rather than automatic, which is the premise of "quick track must be
invisible").

**Consequence:** the AST-loading path costs ~420 ms on the first parse in a
process and ~13 ms after. Budgets were re-derived from measurement rather than
assumption; see §3.

---

## 2. Hooks never import zod

**Spec:** §0.9 — "Every config file is schema-validated. Fail loud at
`keel init`. Fail safe at runtime."

**Problem:** measured cost of importing zod is **~26 ms of module init**, plus
~11 ms to construct our schemas — on *every tool call*, which was more than
everything else a hook did put together.

**Decided:** read §0.9 literally, because it already describes two different
behaviours. `src/shared/config-schema.ts` holds the strict Zod schema and is
loaded by `keel check`, `keel init`, and `SessionStart` (lazily, once per
session) — the "fail loud" half. `src/shared/config.ts` holds a dependency-free
coercing reader used by hooks — the "fail safe" half. The same split applies to
`standard.yaml` (hand-validated, since `loadPacks` runs in three hooks) and to
telemetry.

**The obvious objection** — two validators will drift — is answered structurally,
not by discipline:

- `tests/shared/config.test.ts` runs a corpus of valid configs through both paths
  and asserts byte-identical output.
- `config-schema.ts` carries a compile-time assertion that the schema's output is
  assignable to the hand-written `KeelConfig` interface.
- `npm run bench:size` greps each hook bundle for zod's runtime markers and fails
  the build if one reappears.

**Result:** hook bundles fell from ~450 KB to 121–177 KB and `post-tool-use` from
202 ms p95 to 110 ms.

**Bonus:** replacing zod in telemetry with an explicit per-kind serialiser made
the privacy guarantee *stronger*. Schema rejection drops events with unknown
fields; an allowlist serialiser never reads them, so there is no path from an
unexpected input field to disk at all.

---

## 3. Hook cold start is gated on p50, not p95

**Spec:** §0.5 gives p95 budgets. M0.3 asks each bundle to cold-start in < 80 ms.

**Problem:** on a shared runner, p95 over 30 samples swings by ~30 ms run to run
with identical code — the same hook measured 61 ms and 98 ms on consecutive runs.
p50 is stable to within ~3 ms.

**Decided:** gate on p50, report p95. A gate that fails for reasons unrelated to
the diff gets disabled, and a disabled gate is worse than a looser one. The
benchmark also reports the Node spawn floor (~30 ms) separately, so the budget
applies to Keel's own cost rather than to overhead nobody can remove.

**Measured, after optimisation:** 32–73 ms p50 own-cost across the six hooks,
against an 80 ms budget.

---

## 4. `ChangeSignals.externalCallerCount` is insufficient as specified

**Spec:** M3 defines `externalCallerCount: number` (one aggregate), but rule 2
says a hot symbol escalates to *full* "if it crosses a package boundary" —
which is a per-symbol property an aggregate cannot express.

**Decided:** the per-symbol record (`ChangedSymbol`) is the real signal;
`externalCallerCount` is retained as the derived maximum so the documented
interface still holds.

---

## 5. A crashed gate fails open, not closed

**Spec:** §0.3 says both "a crashed hook must never break a developer's session"
and "gates fail closed with `exit 2`".

**Read as:** the second sentence is about a gate's *verdict*, not its *crash*. A
detected violation exits 2. A rule that throws, fails to compile, or hangs
reports an error and exits 0. The alternative — a bug in Keel blocking all work
in a repo — contradicts the headline constraint in the same paragraph.

A 2-second per-rule timeout was added so a rule that never resolves is bounded by
the runner rather than by Claude Code's hook timeout.

---

## 6. `scripts/` is committed build output

Claude Code plugins are consumed directly from a git checkout; there is no
install step that would run esbuild. Committing the bundles is what makes the
plugin work when installed from a marketplace. CI fails if they differ from a
fresh build, so they cannot silently drift.

---

## 7. Pack rules are transpiled on demand

**Spec:** M4 shows `rule.ts` in the pack format and requires that adding a
standard is "a folder plus a PR — zero changes to `src/`".

**Problem:** `import()` cannot execute TypeScript, and a build step for pack
authors would break the "folder plus a PR" promise.

**Decided:** transpile with `ts.transpileModule` on demand, cached under
`.keel/cache/packs/` by content hash. ~1 ms once the compiler is resident, and
the compiler is already loaded whenever an AST gate runs. Pack rules may only use
`import type`, since transpilation is single-file — documented in the
`keel-standards` skill.

---

## 8. Gate 4 was too aggressive, and this repo's own suite proved it

The M6 acceptance test — zero false positives across this repository's full test
suite — failed on first run with 13 findings, and both causes were real bugs:

1. **`it.each(table)(name, fn)` is curried.** Reading the inner call as the test
   declaration made every table-driven test look assertion-free.
2. **`toBeDefined` / `toBeNull` are not weak matchers.** Asserting that a value
   *is* undefined is often the exact behaviour under test. `WEAK_MATCHERS` was
   narrowed to genuinely uninformative matchers (`toBeTruthy`, `toBeFalsy`,
   `assertTrue`). They remain in the gate-1 downgrade map, where the signal is
   the *replacement* of a strong matcher rather than the matcher itself.

Recorded because it is the clearest evidence for why that acceptance criterion
was worth the effort.

---

## What was tempting to stub, and what was done instead

Build spec §5.4 asks for this explicitly.

| Tempting | Done instead |
|---|---|
| Invent Superpowers/OpenSpec version numbers | Shipped `UNPINNED` until a human supplied them, with `keel check` failing and naming the fix. Now resolved from the real registries — see §9. |
| Write a speculative component-MCP client for M7 | Nothing. M7 is not started. §1 says do not write against a guessed schema. |
| Fabricate 30 "real diffs from this repo's history" for M3 | A 35-case fixture suite that builds a real temp git repo, applies real diffs, and runs the real collector. It found three genuine bugs. |
| Hand-write plausible gotchas for CLAUDE.md | The scanner proposes; `keel gotchas` requires per-item confirmation; nothing unconfirmed is ever written. |
| Ship a `mode: review` reference pack for symmetry | None ships. Review mode is implemented and tested, but neither reference pack is naturally a rubric, and inventing one would be a placeholder. |
| Mock the Python side in TypeScript tests | Real subprocesses throughout, in both directions. |
| Assert `expect(x).toBeDefined()` where behaviour was awkward to check | Real assertions. The one place tempted — the router's caller counting — got a real fixture repo with seven real callers instead. |


---

## 9. Spec Kit is pinned but not installed

**Asked for:** "take the latest superpowers/openspec/speckit versions if
compatible."

**Resolved from the real sources** (2026-08-02):

| Upstream | Version | Where from |
|---|---|---|
| Superpowers | `6.2.0` | `obra/superpowers` tags feed, released 2026-07-24 |
| OpenSpec | `1.7.0` | npm `@fission-ai/openspec` — note the scope; bare `openspec` on npm is an unrelated `0.0.0` placeholder |
| Spec Kit | `0.15.1` | `github/spec-kit` releases, 2026-07-31 |

**Two compatibility findings, both acted on:**

1. **OpenSpec requires `node >=20.19.0`.** This repo declared `>=20`, under which
   an install on Node 20.0 succeeds and then fails at runtime. `engines.node`
   was raised to match.

2. **Spec Kit cannot be installed alongside the other two.** Its
   `/speckit.specify` and `/speckit.plan` own *design* and *planning* — the
   phases the plan assigns to OpenSpec and Superpowers. Installing all three
   puts two owners on both phases, which is the failure rule 7 exists to prevent
   and which `keel check` now detects.

   This is not a workaround. The plan is explicit that Spec Kit contributes
   **"Two ideas only: the 'constitution' concept (kept tiny) and the
   extension/preset pattern we copy for standards packs."** It was never meant
   to be an installed workflow tool.

**Decided:** a `role` field on each lock entry. `install` means Keel installs it
and it owns phases; `pattern-source` means we borrowed ideas and install
nothing. Spec Kit is pinned as a pattern source so the borrowed ideas stay
traceable to a version, and a pattern source that declares `owns:` is an error.

**Also completed while here:** the `owns`-versus-`PHASE_OWNERS` cross-check that
M2.3 asks for, which the first pass declared but never wired up. Two
dependencies claiming one phase now fails `keel check` and names both.

**Still outstanding:** internal mirrors for the two installed dependencies.
Reported as a warning rather than an error, because the lock is usable without
them and blocking on a mirror nobody has set up yet would help no one.


---

## 10. Mutation testing is ours, not Stryker's

**Plan:** week 8 — "Assertion lint + mutation testing in CI, diff-only", gating
on mutation score with a ~50% floor.

**Considered:** StrykerJS, the standard JS mutation runner.

**Decided:** build it. Three reasons, in order of weight:

1. **Both languages.** Stryker is JS-only. A Python-side mutation story would
   have to be a second tool with a second config, a second score and a second
   way to be wrong.
2. **Diff-only is the hard requirement.** Stryker's incremental mode re-runs
   what changed; the plan wants mutants *confined to changed lines*, which is a
   different thing and the reason this is survivable on a legacy repo at all.
3. **The AST layer already exists.** Generating mutants is one more consumer of
   the TypeScript compiler wrapper and `keel_gates`, which are already built,
   already lazy-loaded and already tested.

The runner is deliberately dumb: apply one edit, run the repo's own test
command, restore. No test-impact analysis, no parallel workers, no incremental
cache. Those are the features that make a mutation tool fast *and* make its
score hard to trust; the cap on mutants per run buys the same wall-clock saving
with none of the ambiguity.

**Determinism was designed in, not discovered.** Selection sorts by position and
strides, so the same diff always produces the same mutants and the same score.
A gate whose result moves between runs on identical code is a gate people learn
to re-run until it passes.

---

## 11. Spec Kit and Superspec are pinned but not installed

Both contribute *patterns*, not tooling, and installing either would put a
second owner on a phase the plan has already assigned:

| Upstream | Plan says it contributes | Would claim |
|---|---|---|
| Spec Kit | the constitution concept, and the preset pattern copied for standards packs | design, planning |
| Superspec | "the wiring between those two — OpenSpec plans, Superpowers builds" | planning |

Superspec's contribution is already implemented: it *is* Keel's phase-ownership
map, enforced by `keel check`. Recording both as `role: pattern-source` keeps
the provenance without creating a conflict.

**One honest caveat:** npm carries roughly ten packages named some variant of
"superspec". The pinned one matches the plan's wording exactly in its
description, but the identification is unconfirmed and says so in the lock file.
It installs nothing, so a wrong pin costs a wrong citation and nothing else.

---

## 12. The full-track proposal requirement is not a per-edit hook

**Plan:** full track means proposal → plan → build → verify → archive.

**Tempting:** block edits at `PostToolUse` when a full-track change has no
proposal.

**Rejected.** Deciding the track needs the router, and the router counts callers
with `git grep`. Running that on every Write would cost more than every other
gate put together, and rule of the road 1 — the quick track must be invisible —
outranks catching a missing proposal a few minutes earlier.

**Instead:** `keel spec check --track full` and CI enforce it, and `keel route`
prints the full-track process when it routes there. The gate still exists; it
just runs where a human is already waiting.

---

## 13. Where the plan and this build differ

Everything the plan asks for is built except the two items excluded by the
maintainer (UI bridge, PDF migration) and one deferred by the plan itself.

| Plan item | State |
|---|---|
| Integration TDD (`outer_loop`) | Deferred **by the plan**, not by us. Config carries and honours `outer_loop: false`. |
| `guide`-mode reference pack | None ships. A guide encodes org-specific judgment — the PDFs' content. Format is documented and tested; inventing one would be inventing policy. |
| Pilot repos, named owner, per-team champion | Organisational, not code. |
| Managed Code Review configuration | The recommendation is written (README, "managed vs plugin settings"); the decision is the org's, as M9.4 requires. |
| Skill enable/disable wiring | Partly impossible. See §14. |


---

## 14. Superpowers' skills cannot be subset from settings

**Plan / build spec M2.4:** enable a subset of Superpowers' skills, "leave the
rest disabled by default, listed in config so teams can opt in". The acceptance
criterion is "disabling a skill in config actually removes it from the session".

**What the platform provides:** a `skillOverrides` setting mapping skill name to
`"on" | "name-only" | "user-invocable-only" | "off"`.

**Why that does not finish the job:** the documentation is explicit —
*"Plugin skills are not affected by `skillOverrides`. Manage those through
`/plugin` instead."* Superpowers ships as a plugin, so its skills are plugin
skills. There is no per-skill toggle for them; a plugin is enabled or disabled
whole.

**Decided:** write `skillOverrides` for the skills it *can* control, and say
plainly that the rest is not a setting. `keel init` prints the limitation and
points at `/plugin`.

The alternative — writing `skillOverrides` entries for Superpowers' skills
anyway — would produce a config that looks correct, passes review, and does
nothing. A gate that silently no-ops is worse than an absent one, because
nobody goes looking for it.

**M2.4's acceptance criterion therefore cannot be met as written** for
plugin-sourced skills. Recorded here rather than quietly marked done.

---

## 15. Effort is written to local scope, and only when asked

**Plan:** "Effort by track. Quick → low. Standard → medium. Full → high. Routed
by the router, overridable per turn."

**Mechanism:** `effortLevel` in settings.json, accepting
`low | medium | high | xhigh`.

**Two decisions on top of it:**

1. **Local scope, not project.** The level follows *this change's* track, which
   is a per-developer, per-branch fact. Writing it to the shared
   `.claude/settings.json` would pin the whole team to whatever track the last
   person to run `keel route` happened to be on.

2. **Behind `--apply-effort`, not automatic.** `keel route` is otherwise a read:
   it answers a question and changes nothing. Having it silently rewrite
   settings as a side effect is the kind of surprise that makes people stop
   trusting a tool. The flag is one word and the output says so when it is
   absent.

"Overridable per turn" is Claude Code's own — Keel sets the default for the
track and gets out of the way.

---

## 16. No managed settings in v1; telemetry on by default, local-only

**Build spec M9.4** required a recommendation, not a decision: *"Do not decide
this alone — produce the recommendation and ask."* `docs/managed-settings.md`
carried the recommendation and three questions. The maintainer answered them:
**no managed settings, telemetry on by default, local-only.**

**No managed settings.** Every gate ships overridable, including the two the
recommendation argued were safe to lock (test-weakening and archive-at-merge).
The reasoning for waiting is stronger than the reasoning for either: a gate
nobody can disable and nobody can satisfy does not get followed, it gets routed
around — a different tool, a copied file, or the plugin switched off entirely.
Locking something down is reversible in one direction only, so it should be
earned with measured false-positive rates rather than assumed.

The second question — who owns the exception process — is moot while nothing is
locked, and is deliberately left unanswered rather than answered speculatively.
Whoever revisits question one inherits it.

**Telemetry on by default.** Opt-in per repo would have sampled only the teams
already sold on Keel, which is precisely the wrong population for deciding
which gates are wrong. Default-on is what makes the "earn it with data" answer
to question one honest rather than a way of never deciding.

**Local-only.** There is no remote sink and no plan for one. The spool is
JSONL under `.keel/telemetry`, `keel telemetry show` reads it in place, and
`ship` rolls it into a bundle on the same disk. This also retires the
"telemetry destination" blocked input: the destination is the local file, not a
stand-in for an endpoint someone still owes us.

Constraint 0.6 already forbade network calls inside hooks. Local-only extends
that to the whole tool, which means the redaction layer is now defence in depth
rather than the only thing between a secret and a wire.
