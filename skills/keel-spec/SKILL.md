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

### 1. Bootstrap brownfield with `/opsx:onboard`

Point OpenSpec at a legacy service and get back specs describing what the code
**actually does**. Once per repo, human-reviewed, then committed.

```
keel spec onboard    # checks OpenSpec is installed and hands over
```

Do not hand-write specs for existing behaviour, and do not let generated output
land unreviewed. A confident wrong spec is worse than no spec.

### 2. Archive at merge

When a change merges, its delta folds into the capability spec. This is what
keeps specs current — it happens at merge, not as a documentation chore nobody
does. **A merged change with an unarchived proposal fails CI.**

A proposal counts as merged when its frontmatter says `status: applied`, or when
every task in it is checked off. Archive it by moving it under
`openspec/changes/archive/`, or with OpenSpec's archive command.

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
