# Changelog

All notable changes to Keel. Format follows [Keep a Changelog]; versions follow
semver.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/

## [Unreleased]

### Security

**Upgrading: a repo-local pack rule will not run until someone approves it.**
If your repository carries its own `standards/<name>/rule.ts` or `rule.py`, that
rule stops running on this release — in the PostToolUse hook and in `keel gate`
alike — until a human runs `keel trust add <name>` in that checkout. Nothing
about your config changes and nothing errors; the rule simply has nothing to
say. Run `keel trust list` to see what is waiting, read the file, then approve
it. In CI, pass `--trust-repo-rules` instead (see below). Packs that ship inside
the plugin are trusted by construction and are unaffected.

- **A pack rule found in the repository being edited is unsandboxed code, and
  running it is now a decision.** `rule.ts` / `rule.py` are imported and executed
  in-process by the PostToolUse hook with the full privileges of the developer's
  session: any file, any subprocess, the network. Nothing about the pack format
  sandboxes them, and `standards.dirs` defaults to `["standards"]` — so cloning
  an untrusted repository, opening it, and letting Claude edit one matching file
  was enough to execute that repository's code. No config, no prompt, no notice.
  Approval is keyed to the **exact bytes** of the rule file, so editing an
  approved rule invalidates it; trust is in the content, never in the path. Each
  record carries an HMAC over (repo root, pack, rule path, rule hash) under a
  random key held outside every repository, in `KEEL_HOME` or
  `~/.keel/machine-key` — a hostile repo can commit a `.keel/trust.json`, but a
  self-approving record does not verify and the rule does not run. Every
  negative answer degrades to "this pack does not run and says so", never to
  "this edit is blocked" (constraint 0.3). Full reasoning in
  `src/standards/trust.ts`.
- **An untrusted pack is reported as *did not run*, never as *passed*.**
  `keel gate` exits non-zero on one, and so does `keel trust list`; the
  PostToolUse hook used to print "checks passed" for three different outcomes —
  ran clean, crashed, never approved — so a pack author iterating in Claude Code
  saw the same two words on every save with no way to tell their rule was dead.
- **`--trust-repo-rules` on `keel gate`, because a runner cannot approve
  anything.** The two fixes above cancelled out in CI: an approval is signed
  under a machine key that does not survive the runner, so `keel gate` reported
  every repo-local pack as unapproved, exited 1, and advised a machine to run
  `keel trust add`. The gates were reachable from CI in name only. The flag opts
  out, and the reasoning is that approval is meaningless where it would be
  granted — a CI job has already checked the repository out and is already
  running its code (`npm ci` runs its install scripts, `npm test` runs its
  tests), so a pack rule is not a new privilege there. On a developer's machine
  it is, which is why this is not the default. It is a flag rather than a
  `CI=true` sniff: environments set `CI` for many reasons, and a boundary that
  disables itself on a variable someone else controls is not a boundary. This is
  a choice a human makes once, visibly, in a workflow file — `.github/workflows/ci.yml`
  is the worked example.
- **Compiled rules carry a verified stamp** (`src/standards/rule-loader.ts`).
  The transpile cache was keyed on `sha256(rule.ts)` and a cache *hit* was
  decided by the file existing — the bytes were never checked against the source
  they claimed to come from. So a repo could commit
  `.keel/cache/packs/<pack>-<hash>.mjs`, and that artifact was imported while the
  `rule.ts` a reviewer read was never compiled: the malicious code survived code
  review by never being *in* the review. A truncated write had the mirror-image
  effect, wedging a broken artifact under the key of a good source forever while
  the hook still said "checks passed". An artifact now carries a first-line stamp
  naming the source hash, the hash of its own body, and an HMAC over both under
  the machine key; anything that does not verify is recompiled rather than
  trusted, and writes go through a temp file and a rename so a half-written
  artifact is never visible under the real name.
- **The trust HMAC binds to the *canonical* repo root.** It bound to a root
  `resolve()` had normalised but not canonicalised. `keel trust add` reaches the
  root through `process.cwd()`, which the OS has already resolved; the hook
  reaches it through whatever `cwd` Claude Code passes. Differ by a symlink —
  macOS hands out `/tmp` for `/private/tmp` — and the MAC stops matching, the
  gate silently stops running, and re-approving does not help, because the new
  record is signed against the canonical root too. Unfixable, and visible only
  under `KEEL_DEBUG`.
- **Redaction reached the model.** It was wired into the debug log only — the one
  channel that does *not* reach Claude — while the blocking reason fed straight
  back to it was unprotected. Keel's own assertion-lint gate quotes the test
  name, so a test named after a token leaked it with no custom pack involved. It
  is now applied in `emitAndExit`, the single point every hook's output leaves
  the process, for the same reason the fail-open contract lives there: no hook
  can then forget. The CLI was fixed the same way a pass later — every write in
  `src/cli/output.ts` goes through one of two functions, both of which redact,
  because `keel gate --json` is exactly what a job pipes into a log or a PR
  comment.
- **Repo-supplied `guide.md` can no longer break out of its fence.** The fence
  used a fixed delimiter and did not escape the body, so a guide containing the
  closing tag landed its payload outside the fence, presented as Keel's own
  words. The tag now carries a per-invocation nonce and the body is defanged.
- **`isInsideRepo` is wired up.** It existed, documented as rejecting "`../`
  escapes and absolute strays", with zero call sites; it now guards
  `standards.dirs`, `telemetry.path` and `spec.dir`, and had a hole of its own —
  the repo's own parent passed the check. `resolveConfiguredPath` also fell back
  to the repo root when the *default* escaped, which a repo can arrange by
  committing `standards` as a symlink: that made the whole repository a pack
  search root and let an out-of-tree `guide.md` in through the back door.

### Fixed — gates that were not gating

The recurring shape across two review passes: a mechanism proven in isolation
and assumed to be connected everywhere. Each item reproduced before it was
fixed.

- **Three of Keel's own files were invisible to Keel's own gates.**
  `src/shared/glob.ts`, `tests/shared/paths.test.ts` and
  `tests/display/format.test.ts` each contained a raw NUL byte where an escape
  was intended. Git classifies such a file as binary and emits no hunk headers,
  so `changedLines` returned an empty set and every finding on those files was
  dropped — the standards gates, all four TDD gates and `keel mutate` could never
  fire on them. In a tool whose second rule of the road is "diff-only, always",
  three of its own files sitting outside every diff is the worst kind of quiet
  failure. Every tracked file is text now.
- **Hooks did not fail open, they blocked.** `changedLines` answered "git could
  not tell us" with "every line is new", so the gates evaluated whole files and
  blocked edits to committed, unmodified code when git was missing, when the
  directory was not a repository, and — the case real users would have hit —
  when the file was gitignored, so every edit to generated code blocked. It now
  returns a discriminated result and callers report nothing when the answer is
  unknown. Hooks also exited 1 on oversized stdin, and 1 means *non-blocking*, so
  the guarantee was inverted at exactly the moment it mattered.
- **`keel mutate` reported a perfect score when it could not run tests at all.**
  Score 1, passed, exit 0 when no test command could be detected — so a repo
  whose test script was renamed would post a perfect mutation score forever, in
  the job standing in for coverage. "Nothing to mutate" (a docs change) and "the
  instrument is broken" are now different answers, and a mostly-errored run
  reports inconclusive rather than passing on the remainder. Separately, the gate
  generated zero mutants on every PR: the file list came from `--against` while
  the line set was hard-wired to HEAD, so a clean CI checkout produced a perfect
  score without testing anything.
- **`keel gate` exited 0 while printing "a dropped gate is not a passed gate".**
  The hook's fail-open contract does not transfer to the CI surface: failing open
  is right when someone is typing, and wrong when the job's whole purpose is to
  notice that a rule stopped being enforced. Blocking findings, untrusted packs,
  rule errors, budget drops and unknown diffs all fail the command now.
- **Config strictness was only skin deep.** The README promises that an unknown
  key is an error. Only the root object was strict, and every tuning knob a team
  actually touches lives in a nested section: `router.quick_max_flies: 3`
  validated clean and silently ran the default. Every section is strict now, and
  the error names the section.
- **The TDD state file cost more than the hook's own timeout.** `applyEntry`
  deep-copied the whole expectations map per journal record, so folding N records
  was O(N²), and the gate runner then read the state once per new exported symbol.
  A 20-export edit against an 800-expectation snapshot and a 120 KB journal took
  23.8 s locally and 40 s on a reviewer's machine, against a registered 30 s hook
  timeout: Claude Code kills the hook, the TDD gate produces no verdict, and the
  edit appears to hang. The fold now mutates an accumulator and materialises the
  immutable state once, `readState` short-circuits when nothing is pending, and
  the runner takes one ledger read. The same edit takes 765–970 ms — node start
  plus the lazy `typescript` load, identical to the empty-state case. Folding
  8,000 records went 17.4 s to under 300 ms.
- **Concurrent compaction discarded committed TDD records.** Each write was
  atomic; the read-fold-write *sequence* was not, so two overlapping compactions
  clobbered each other and the loser's journal had already been unlinked. Eight
  writers × 400 records kept 2,292 of 3,200. A lost RED means gate 3 blocks an
  edit the developer already earned. Compaction now holds an exclusive lock with
  a stale-lock timeout, rotates the journal to a fixed name before folding, and
  deletes the rotated file only after the snapshot it produced is on disk: 3,200
  of 3,200. (Before that, the file lost writes outright — eight concurrent hooks
  kept 34 of 320 — which is what the snapshot-plus-journal design fixed.)
- **Nothing ever pruned the TDD state.** `writeState` and `clearBranch` had no
  callers, and both doc comments named `keel doctor --reset-tdd`, a flag that
  does not exist and that the new argument validator now rejects. So the file
  accumulated every test file on every branch ever used, which is what fed the
  O(N²) cost above. Retention now lives in compaction: branches git no longer has
  are dropped (skipped entirely, not guessed, when git cannot answer), then
  global caps on branches, expectations and implemented symbols, allocated
  round-robin so no branch starves the others. The current branch is never
  dropped. A manual reset still wants a `--reset-tdd` flag on `doctor`; both
  functions are exported and ready, only the CLI wiring is missing.
- **The telemetry serialiser rewrote `untrusted` and `skipped` to `pass` on
  disk** — the type was widened and the runtime allowlist was not, one file from
  the comment explaining why that exact conflation must not happen. The allowlist
  is a mapped object now, so omitting a member is a type error.
- **A polyglot repo lost half its commands.** `detectCommands` is keyed by role
  and the npm scripts overwrote the Python ones, so a TypeScript + Python repo
  got a CLAUDE.md listing only `npm test`. The model would run it, see it pass,
  and report a green suite having executed no Python tests — with
  `languages: [typescript, python]` sitting beside it making the omission look
  deliberate.
- **Two properties could be deleted with the whole suite still green** (874 tests
  at the time): the standards gate's fail-open path, and `keel mutate`'s
  `--against` wiring — the latter reverted to the exact bug whose own comment
  describes it. Both are the difference between a gate and a decoration, and
  neither was guarded. `tests/hooks/gate-integrity.test.ts` kills those mutants
  and four more now, all
  driving the shipped bundles rather than the modules underneath — because every
  one of these was previously "covered" at a layer that could not observe it. A
  unit test of `redact()` says nothing about whether anything calls it.
- Router and gate accuracy: body-only edits to `export const` and to class
  methods read as signature changes; renames parsed from git's compressed
  `{a => b}` form routed a file moved into a `force_full_globs` directory as
  quick; untracked files counted a phantom trailing line, binaries counted as
  lines, symlinks were analysed as copies of their target; Python mutation spans
  used byte offsets as character offsets, so any non-ASCII on the line produced
  an invalid mutant that was then scored as a kill; and size alone could never
  reach the full track, so a 60-file, 9,000-line change routed like a three-file
  one. Gate 2 caught nothing in Python — its test was named "blocks a Python test
  that patches its own module" while asserting the opposite. Gate 3 blocked
  correct TDD on the default JS layout. Gate 4 blocked tests that delegate to a
  helper, and ignored the escape hatch its own message recommended.
- **Silent failures that made process quietly evaporate are loud now.** An
  `--against` ref that does not resolve was routing every change to quick with
  exit 0 and an empty stderr — in CI that meant all process stopped applying and
  nothing said so. `review record` coerced a non-numeric count to 0, silently
  zeroing the project's headline metric. `route` ran on coerced defaults when the
  config would not parse, so `force_full_globs` stopped applying with no warning.
- **The Superpowers pin was decorative.** A marketplace added without a ref
  tracks the default branch, so `version: "6.2.0"` was a comment. The install
  command carries `#v6.2.0` now, an install command without its pin is a lock
  error, and the installed version is read from the real manifest — so
  `wrong-version` is reachable at all, where it previously could not be returned
  under any circumstances.
- **`agents/keel-reviewer.md` moved to `templates/agents/`.** Claude Code
  auto-discovers `agents/` at plugin root, and plugin-shipped agents cannot carry
  `permissionMode`, which this one sets and needs. It was therefore registered
  twice, once invalidly. With the directory gone there is exactly one
  registration: the copy `keel init` installs into `.claude/agents/`, where the
  field is supported.
- **`keel init` scaffolds the `upstream.lock` every "run `keel init`" message had
  been promising**, with an empty `dependencies: {}` — guessing pins would be
  worse than shipping none. `check` and `doctor` call `upstreamStatus` rather
  than only validating the lock, so this repository now reports openspec as
  pinned and not installed instead of showing it a green tick.
- Both finding renderers printed `fix: undefined` when a rule supplied no fix.
  `fix` is optional on a `Finding`, and the literal string reached the developer
  as though it were advice.
- The observed-RED message named `--spike`, which is not a flag on any command
  and could not be passed to a hook that fires on Write/Edit. It is
  `KEEL_SPIKE=1`. `keel review` recommended `/verify`, which does not exist.
- `process.exit` discarded queued output, cutting a blocking reason off mid-word
  at ~146 KB over a pipe. Output drains before exit now.

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
  and neither does `keel telemetry show`; the `mutationTrend()` helper the claim
  rested on had no caller and has since been deleted, so the feature no longer
  reads as shipped. The README says what exists: the events are spooled, nothing
  reads them back, and ratcheting is a hand edit.
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
- **The README documented an effort level the schema rejects.** The config
  example said `# low | medium | high | xhigh`; `EFFORTS` in
  `src/shared/config.ts` is three values, and `keel check` fails an `xhigh` with
  `tracks.full.effort: Invalid option`. The fourth value belongs to Claude Code's
  own `effortLevel` field, not to Keel's `tracks` — `docs/decisions.md` §15 now
  says which enum is which, because copying the wrong one produced a config that
  will not load.
- **The Upstream table listed three dependencies; `upstream.lock` pins four.**
  `superspec @ 0.1.11` was missing from the README along with its
  `IDENTIFICATION IS UNCONFIRMED` caveat, while `keel check` prints it and
  `docs/decisions.md` §11 explains it — so the README was the only place it was
  hidden, in a document whose stated posture is "stated up front rather than
  discovered three days in".
- **`npm run verify` is not "every gating check, in the order CI runs them".**
  It is typecheck, lint, build, test, bundle size and the three Python checks.
  CI additionally runs the committed-bundle freshness check and four Keel-on-Keel
  gates — `keel mutate`, `keel spec check`, `keel gate`, `keel check` — that
  `verify` never touches, so a green `verify` could still go red on five things.
  The README now says what `verify` covers and what it does not.
- **`keel telemetry` was missing from the command list**, despite being a
  declared command with three subcommands that the README itself uses further
  down.
- **There was no CI documentation at all.** The README argued `keel gate` exists
  for CI coverage, said `keel spec check` in CI is where the process gates that
  matter are enforced, and called `keel mutate` "CI only" — and never showed a
  workflow, a base-ref computation, or `--trust-repo-rules`, which appeared in
  exactly one file in the repository and no prose anywhere. A new "Continuous
  integration" section shows the minimum shape and points at
  `.github/workflows/ci.yml`.
- **`keel init` writes all ten config sections, every key at its default**, each
  with the comment that explains it, and the values come from the canonical
  defaults rather than being retyped in the scaffold, so the generated file
  cannot drift from what Keel actually falls back to. It wrote six of ten before;
  `upstream`, `display`, `spec` and `mutation` appeared in neither the generated
  file nor the README, and `mutation.test_command` was discoverable only from the
  error message you got when mutation testing could not find a test command. The
  README's config example matches it, down to `packs_ref: keel-standards@0.1.0`
  (it said `@1.0.0`).

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
  change no reviewer saw — was exactly the wrong thing to exempt.
- **A push diffs against `github.event.before`, not `HEAD^`.** The two agree for
  a merge commit and for a squash, which is why the mistake survived review, but
  a rebase-merge fast-forwards N commits at once and `HEAD^` then names the
  second-to-last of them: everything before it was never gated and never
  mutated. Both the mutation job and the standards-gates job compute the base the
  same way, and both fall back to `HEAD^` only when `github.event.before` does
  not resolve.
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
  only, same as the hook. It passes `--trust-repo-rules`; `--all` is deliberately
  withheld, because CI blocks on `high`-severity findings and advisory ones
  belong in the editing loop where they can be acted on. Adopters can copy the
  job — the README's new "Continuous integration" section shows the minimum
  shape, including the base-ref computation and why `--trust-repo-rules` belongs
  in a workflow file and nowhere else.

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

- **`keel gate`** — run the standards gates over a diff, outside the editing
  loop. Until it existed, `runGates` had exactly one caller: the PostToolUse
  hook. Standards were therefore enforced only when Claude Code did the editing,
  and the one place a team actually blocks a merge was the one place the gates
  were absent. Same rules as the hook — diff-only evaluation, `high` severity
  blocks, a rule that cannot run reports an error and never blocks — with one
  deliberate difference: it exits non-zero when a gate *did not run*, because a
  dropped gate is not a passed gate. Flags: `--against <ref>`, `--json`,
  `--all`, `--trust-repo-rules`.
- **`keel trust [list|add <pack>|remove <pack>]`** — the human half of the pack
  trust boundary above. `list` shows every repo-local rule that will not run,
  where it lives, what it hashes to, and whether it was never approved or has
  changed since; `add` approves every rule file in one pack at its current
  contents; `remove` revokes. Hooks never prompt, which is exactly why approval
  needs a command — without it the security fix would have been a wall with no
  door. Approvals live in `.keel/trust.json`, which is gitignored: trust is per
  checkout, not something a repository grants itself.
- **`src/cli/registry.ts` — one declared command and flag table.** The usage
  screen is rendered from it and every flag is validated against it, which closes
  three defects structurally rather than one at a time. `keel route --trak full`
  used to exit 0 having silently ignored the typo, so a developer believed they
  had overridden the track and had not; unknown flags and unknown subcommands are
  now rejected by name, with a near-miss suggestion and the list of what the
  command does accept. `--version` printed the usage screen. And `--help` had
  drifted, omitting four flags `review record` actually reads.
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

### Removed

- **Twenty exports nothing called.** A scan for exported symbols with no
  reference anywhere in `src/`, `tests/` or `scripts-dev/` found twenty, each
  appearing exactly once — in its own declaration. Dead code here was not inert:
  two of them had already made the documentation claim behaviour that did not
  exist. The README described a mutation-score ratchet driven by
  `mutationTrend()`, which no command called, so the feature read as shipped;
  `writeState` and `clearBranch` named a `keel doctor --reset-tdd` flag the
  argument validator rejects. An export with no caller is a promise nothing
  keeps.
- **`sourceCandidatesFor` / `existingSourceFor`** — the reverse direction of test
  pairing, source-from-test. Not merely unused but wrong:
  `dir.replace(/^tests/, "src")` never resolves a monorepo layout, so
  `packages/api/tests/util/money.test.ts` could not find its source, and `test/`,
  `spec/` and `__tests__/` roots failed too. The forward direction the gates
  actually use is correct and well covered; deleting the broken half removes a
  trap for whoever wires up source-from-test later, who would otherwise have
  started from something that looked finished.
- `matchesAnyAbsolute`, `reviewTrend`, `setSessionId`, `isFullyPinned`,
  `pluginDirExists`, `archiveDir`, `fileOverride`, `readYamlFile`, `headSha`,
  `mergeBase`, `isOk`, `readStdin`, `logInfo`, `resetTypeScriptCache`,
  `TrackSchema`, `Role`, and `PYTHON_BINARY_MUTATIONS` — a second, unused source
  of truth for an operator table the Python side already owns.

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
