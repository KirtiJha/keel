---
name: keel-spec
description: Use on full-track changes — anything touching migrations, auth, openapi, or a widely-called symbol across a package boundary. Covers writing an OpenSpec proposal, the delta markers reviewers read, the spec size cap, and archiving at merge. Triggers on "full track", "write a proposal", "spec delta", "archive the change", "opsx".
keel-phases: []
---

# Full-track spec discipline

Full track means: **proposal → plan → build (test-first) → verify → archive.**

OpenSpec owns the design phase. Keel owns the discipline around it — four rules,
all mechanical, all checked by `keel spec check` and in CI.

## Starting a change

```
keel spec new <change-id>     # scaffolds structure, not content
keel spec list                # what exists and what state it is in
```

That creates `openspec/changes/<id>/` with a `proposal.md` carrying frontmatter,
the standard headings, and the three delta markers. What goes under them is
yours and OpenSpec's; Keel deliberately writes no prose.

## The four rules

### 1. Learn the loop on your own repo with `/opsx:onboard`

```
keel spec onboard    # checks OpenSpec is installed and hands over
```

**What it actually is.** `/opsx:onboard` is a guided walkthrough of one
end-to-end change: OpenSpec finds something small and safe to improve in your
codebase, then takes you through proposing, building and archiving it,
explaining each step. It is a tutorial that produces one real change.

**What it is not.** It does **not** reverse-engineer specs from existing code.
OpenSpec ships nothing that does — there is no command that reads a legacy
service and emits specs describing what it currently does, and its own docs do
not cover brownfield adoption at all. If you were expecting a bootstrap pass
that fills `openspec/specs/` from the code you already have, it does not exist,
in OpenSpec or in Keel.

**It is expanded-profile only.** On a default OpenSpec install the command is
not there. The core profile has `/opsx:propose`, `/opsx:explore`, `/opsx:apply`,
`/opsx:update`, `/opsx:sync` and `/opsx:archive`; `/opsx:onboard` sits with
`/opsx:new`, `/opsx:continue`, `/opsx:ff`, `/opsx:verify` and
`/opsx:bulk-archive` in the expanded set. Switch with `openspec config profile`
and apply with `openspec update`, then re-run.

**So how does a legacy repo get specs?** One change at a time. Specs accrete:
the first full-track change in an area writes the spec for the part it touches,
and the archive-at-merge rule below keeps it current from then on. That is
slower than a bootstrap pass and it is the honest answer — a spec generated in
bulk from code nobody reviewed is a confident, wrong, permanent description of
behaviour, which is worse than an absent one.

### 2. Archive at merge

When a change merges, its delta folds into the capability spec. This is what
keeps specs current — it happens at merge, not as a documentation chore nobody
does. **A merged change with an unarchived proposal fails CI.**

A proposal counts as merged when its frontmatter says `status: applied`, or when
every task in it is checked off. Archive it by moving it under
`openspec/changes/archive/`, or with OpenSpec's archive command.

The archive rule only fires on the default branch. Locally that is detected from
the branch name (`main`, `master`, `trunk`); in CI it usually is not, because
`actions/checkout` leaves a detached HEAD and `git rev-parse --abbrev-ref HEAD`
then answers `HEAD` — so pass `--default-branch`, as Keel's own CI does when
`github.ref` is `refs/heads/main`.
Everywhere else the size cap and the proposal requirement still run and the
archive rule does not, because an unarchived proposal on a feature branch is just
work in progress.

### 3. Cap the spec at ~250 lines per change

Counted across every markdown file in the change. Over the cap warns; far over
it fails.

**Verbose specs are a defect, not thoroughness.** The most common complaint
about heavier tools is that reviewing the markdown is worse than reviewing the
code. If the spec is longer than the diff, something is wrong — cut it back, or
split the change.

### 4. Attach the delta to the PR

Mark what changed with these headings in the change's spec files:

```markdown
## ADDED Requirements
- ...

## MODIFIED Requirements
- ...

## REMOVED Requirements
- ...
```

```
keel spec delta               # rendered markdown on stdout
keel spec delta --out d.md    # or to a file
```

CI posts it as a PR comment and updates it in place on later pushes.

This is the adoption lever. Reviewers read what changed and why without
reverse-engineering the diff — and once reviewers start asking for the delta,
authors write them without being told.

## Optional: EARS acceptance criteria

Off by default. Turn it on with `spec.ears: true` to trial it:

```
WHEN <trigger> THE SYSTEM SHALL <response>
IF <condition> THEN THE SYSTEM SHALL <response>
WHILE <state> THE SYSTEM SHALL <response>
WHERE <feature> THE SYSTEM SHALL <response>
THE SYSTEM SHALL <response>
```

Each line maps cleanly to one test, which helps while testing habits are being
built. Warnings only, never a block. **Try it on two changes, then decide** —
that is what the plan asks for, and there is no default answer.

## Not doing

- **No functional/technical split.** It confuses people in practice and the
  payoff is theoretical. One spec, written however the author thinks clearly.
- **Spec-as-source is out of scope.** Code stays the source of truth and tests
  stay the enforcer. We are spec-*anchored*: the spec is kept and evolved, not
  the thing humans edit instead of code.
