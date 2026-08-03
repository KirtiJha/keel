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

Declare the contract in the rule file. It is four fields and two types, and it
is the form that works in any repository:

```ts
// standards/<name>/rule.ts

interface Finding {
  line: number;          // 1-based, in the file being checked
  column?: number;       // 1-based; defaults to 1
  message: string;       // what is wrong — one sentence, no rule name
  fix: string;           // what to do instead
}

interface GateContext {
  path: string;                    // repo-relative, POSIX separators
  source: string;                  // full text of the file
  changedLines: ReadonlySet<number>;  // 1-based lines this change touched
  config: Record<string, unknown>; // the `config:` block from standard.yaml
  ast: {                           // null for non-TS files or no compiler
    ts: typeof import("typescript");
    sourceFile: import("typescript").SourceFile;
    lineOf(pos: number): number;   // 1-based line for a character offset
    columnOf(pos: number): number; // 1-based column
  } | null;
}

const rule = (context: GateContext): Finding[] => {
  const parsed = context.ast;
  if (parsed === null) return [];

  const findings: Finding[] = [];
  // parsed.ts is the TypeScript compiler API; parsed.sourceFile is the AST.
  return findings;
};

export default rule;
```

**Why not import the types.** Keel does not publish a types package, so there is
no specifier that resolves from a consuming repo. `import type { Finding,
GateContext } from "../../src/standards/types.js"` resolves only inside the Keel
checkout itself; in your repo it points at a `src/standards/` you do not have,
and your editor and `tsc` both go red.

This costs nothing at runtime. Rules are matched **structurally**, not by
identity: the runner passes a plain object and reads a plain array back. And
`import type` is erased before the rule ever runs — rules are transpiled
single-file, so a *value* import would not resolve anyway, which is why only
type imports are allowed at all.

If you are authoring inside the Keel repository, import from
`../../src/standards/types.js` as the shipped packs do. If you want the real
types in your own repo, a `paths` entry in `tsconfig.json` pointing at a Keel
checkout works and is a local editor convenience, not something to commit as a
dependency.

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

## A repo-local rule must be trusted before it runs

A pack's `rule.ts` is code, executed in-process by the PostToolUse hook with the
full privileges of the session. Packs shipped inside the plugin are trusted by
construction. **A pack found in the repository being edited is not** — otherwise
cloning a hostile repo and opening one matching file would be enough to run its
code.

```
keel trust list           # what is untrusted, where it lives, what it hashes to
keel trust add <pack>     # approve it
keel trust remove <pack>  # revoke
```

Approval is keyed to the exact bytes of the rule file, so **editing your rule
invalidates it and you approve again**. If a pack you just wrote produces no
findings and no errors, this is the first thing to check: `keel gate` and
`keel doctor` report an untrusted pack as *did not run*, never as *passed*.

Approvals live in `.keel/trust.json`, which is gitignored and signed under a key
outside every repository. Do not try to commit one: trust is per checkout, so a
record your repo carries will not verify on anyone else's machine, and that is
the point — otherwise a hostile repo could ship its own approval.

### In CI, the flag replaces the approval

**`keel gate --trust-repo-rules`.** A runner has no human to approve anything and
no machine key that survives the job, so without the flag every repo-local pack
reports as unapproved, `keel gate` exits 1, and the job is told to run
`keel trust add` — advice a machine cannot take. Your pack would be enforced on
developers' machines and nowhere else.

It is safe in that one place because the job has already checked the repository
out and is already running its code: `npm ci` runs its install scripts,
`npm test` runs its tests. A pack rule is not a new privilege on a runner. It is
a deliberate flag rather than a `CI=true` sniff, because a boundary that disables
itself on a variable someone else controls is not a boundary — so put it in the
workflow file, visibly, and **never in a local alias or a shell function**. Keel's
own `.github/workflows/ci.yml` has the shape to copy, including the base-ref
computation the gate needs.

## Checking your work

- `keel check` — validates every pack, reports unresolvable globs and packs that
  declare a mode but ship nothing to run.
- `keel gate` — runs the gates over the current diff outside the editing loop,
  which is also how they run in CI (there with `--against <base>` and
  `--trust-repo-rules`; see above). The fastest way to see your rule fire.
  `--all` adds advisory findings; it exits non-zero when a gate *did not run*,
  not only when one found something.
- `keel doctor` — shows which packs are active, their timings, and their hit
  rates. A pack that has never fired in 20 runs is a candidate for deletion.

## Rules of the road

- **Mechanical beats written.** Prefer `gate` over `guide` over `review`.
- **Suggest, never force** in guide mode. Conflicting instructions degrade
  output.
- **Delete rules that do not fire.** Reviewed quarterly; the default is removal.
- **Repo-local wins.** A pack in the repo overrides an org pack of the same
  name, and `keel check` reports when that happens.
