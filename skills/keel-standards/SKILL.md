---
name: keel-standards
description: Use when adding, changing, or debugging a Keel standards pack — the folder-plus-YAML unit that carries an org rule as a gate, a guide, or a review rubric. Triggers on "add a standard", "write a lint rule for", "why didn't the gate fire", "standards pack".
keel-phases: []
---

# Authoring a standards pack

A pack is a folder. Adding one is a folder plus a PR — no changes to Keel's
source, ever. If you find yourself editing `src/` to add a rule, stop: the pack
format is missing something, and that is the bug to report.

## Layout

```
standards/<name>/
  standard.yaml   required
  rule.ts         gate mode, TypeScript
  rule.py         gate mode, Python
  guide.md        guide mode
  rubric.md       review mode
```

The folder name and `name:` must match.

## standard.yaml

```yaml
name: api-error-shape          # lower-case kebab-case, matches the folder
mode: gate                     # gate | guide | review
applies_to:                    # globs, repo-relative
  - "services/**/handlers/*.ts"
languages: [typescript]        # typescript, python, or both
owner: platform-team           # an unowned rule is an undeletable rule
severity: high                 # high blocks, medium warns, low informs
description: "API errors use the shared ErrorResponse envelope."
config:                        # optional, passed to the rule verbatim
  envelope_factory: errorResponse
```

## Picking a mode

Work down this list and stop at the first that fits.

- **`gate`** — the rule is mechanical. It runs in a hook, blocks on failure, and
  never enters the model's context. If it can be a lint rule, it must be one.
- **`guide`** — the convention needs judgment. The guide loads only when the
  change touches `applies_to` paths. It suggests; it cannot block.
- **`review`** — the problem is only visible in the finished diff. The rubric
  joins the review chain, filtered to the paths actually touched.

## Writing a gate rule

```ts
import type { Finding, GateContext } from "../../src/standards/types.js";

const rule = (context: GateContext): Finding[] => {
  const parsed = context.ast;      // null for non-TS files
  if (parsed === null) return [];

  const findings: Finding[] = [];
  // parsed.ts is the TypeScript compiler API; parsed.sourceFile is the AST.
  // parsed.lineOf(pos) gives a 1-based line.
  return findings;
};

export default rule;
```

Rules may only use `import type`. They are transpiled per file, so a value
import would not resolve at runtime.

Python rules define a module-level `rule(context) -> list[Finding]` and may
import from `keel_gates.model`.

### Two things the runner guarantees

1. **Diff-only.** Findings on lines this change did not touch are dropped by the
   runner, whatever the rule returns. You never have to filter, and you cannot
   opt out. This is what makes gates survivable on a legacy repo.
2. **A crash is not a block.** A rule that throws reports an error and lets the
   edit through. Your bug must never stop someone working.

## Every finding needs a fix

```ts
{ line, message: "raw colour #ff0044 in `color`", fix: "use tokens.color.danger" }
```

`message` says what is wrong; `fix` says what to do instead. A finding without
an actionable fix is a finding that gets ignored, then switched off.

## Checking your work

- `keel check` — validates every pack, reports unresolvable globs and packs that
  declare a mode but ship nothing to run.
- `keel doctor` — shows which packs are active, their timings, and their hit
  rates. A pack that has never fired in 20 runs is a candidate for deletion.

## Rules of the road

- **Mechanical beats written.** Prefer `gate` over `guide` over `review`.
- **Suggest, never force** in guide mode. Conflicting instructions degrade
  output.
- **Delete rules that do not fire.** Reviewed quarterly; the default is removal.
- **Repo-local wins.** A pack in the repo overrides an org pack of the same
  name, and `keel check` reports when that happens.
