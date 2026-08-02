---
name: keel-init
description: Use when setting up Keel in a repository, or when a developer asks which track a change is on, why a gate blocked them, or how to override Keel's decision. Triggers on "keel init", "set up keel", "why was this blocked", "which track", "keel doctor".
keel-phases: [classification]
---

# Working with Keel in a repository

## Setting up

```
keel init      # writes keel.config.yaml + CLAUDE.md, idempotent
keel check     # validates config, packs, phase ownership, upstream pins
keel gotchas   # review candidates one at a time; nothing is written unconfirmed
keel doctor    # what is active and how fast it runs
```

`keel init` is safe to re-run. It only rewrites between the `<!-- keel:begin -->`
and `<!-- keel:end -->` markers in CLAUDE.md, so anything a human wrote outside
them survives.

## Tracks

The router classifies each change and picks one. It escalates automatically and
never lowers on its own.

| Track | When | Process |
|---|---|---|
| quick | one file, small, no interface change | build, hooks run, done |
| standard | multi-file, or an exported signature changed | plan → build (test-first) → verify |
| full | migrations, auth, openapi, or a widely-called symbol crossing a package boundary | proposal → plan → build → verify → archive |

```
keel route                  # what track, and why
keel route --track quick    # override; always honoured, always logged
```

**A quick change should feel like no process at all.** If a two-line fix feels
slower with Keel than without it, that is a bug in the router — report it with
the output of `keel route`.

## When a gate blocks you

A gate exits 2 and prints the file, line, rule and fix. Do the fix.

Do **not** work around it: do not weaken a test to get to green, do not add
`.only`, do not disable a pack to unblock yourself. Those are the exact
behaviours the gates exist to catch, and Keel will catch them too. If a gate is
wrong, say so and leave it blocked — a wrong rule is worth one interrupted
change and a two-line PR to delete it.

## The TDD gates

Four of them, unit-level only:

1. **Test weakening** — assertions removed, tests deleted, matchers loosened,
   `skip`/`.only` added. Override with a `keel: allow-test-change <reason>`
   comment; the reason is required and is recorded.
2. **Mocking the unit under test** — mock collaborators, not the thing you are
   testing.
3. **Observed RED** — a new exported symbol needs a test that has been *seen*
   failing. Write the test, run it, watch it fail, then implement. If you work
   that way you will never notice this gate exists.
4. **Assertion lint** — no assertion-free tests, no snapshot-only assertions on
   logic.

For genuine exploration, `KEEL_SPIKE=1` relaxes gates 1 and 3 and records the
session as a spike. It does not relax 2 or 4.

## Where things are

- `keel.config.yaml` — tracks, router thresholds, TDD settings, telemetry
- `standards/` — the packs; see the `keel-standards` skill to add one
- `.keel/` — cache, telemetry spool, TDD state. Gitignored, safe to delete.

## Upstream

`upstream.lock` pins Superpowers `6.2.0` (planning, implementation) and OpenSpec
`1.7.0` (design, spec-conformance). Spec Kit `0.15.1` is pinned as a *pattern
source*: we took two ideas from it and do not install it, because its commands
would claim phases OpenSpec and Superpowers already own.

`keel check` rejects moving versions and fails if two things claim one phase.

## Blocked inputs

- **Telemetry destination.** The local spool works; `keel telemetry ship` writes
  a local bundle only.
- **Internal mirrors** for the two installed dependencies — a warning, not an
  error.
