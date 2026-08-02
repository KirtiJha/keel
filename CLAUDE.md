<!-- keel:begin -->
# keel

Spec-driven development plugin for Claude Code: routing, standards packs, TDD gates, terse output.

## Commands

- install: `npm install`
- build: `npm run build`
- test: `npm test`
- lint: `npm run lint`
- typecheck: `npm run typecheck`

## Process

- Run `keel route` to see this change's track — nothing runs it for you. The classification is deterministic and escalate-only; acting on it is advisory. Quick changes need no plan; standard and full do.
- Tests first. The RED run must actually happen — gates check that it did.
- `keel doctor` lists active packs, gate timings and config problems.
<!-- keel:end -->
