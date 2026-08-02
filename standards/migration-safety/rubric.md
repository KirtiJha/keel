Migrations are the one change that cannot be rolled back by reverting a commit.
Review them against the questions below and answer each one explicitly — "looks
fine" is not a review of a migration.

**Is it reversible?**
Every migration needs a down path, or an explicit written reason why it cannot
have one. A destructive migration with no stated recovery plan is the finding.

**Can it run while the old code is still serving?**
Deploys are not atomic. A migration that requires the new code to already be
running will break the window between them. Adding a NOT NULL column with no
default, or renaming a column in one step, both fail this.

**Does it lock a table long enough to matter?**
On the largest table this touches in production — not in the dev database —
estimate the lock. Adding an index without `CONCURRENTLY` (Postgres) or an
online DDL path (MySQL) blocks writes for the duration.

**Is the backfill separate from the schema change?**
Backfilling inside the migration means a single transaction over every row.
Schema change, deploy, then backfill in batches.

**Is the new column or table actually used by this change?**
An unused schema addition is a migration that will be forgotten and then
deleted by someone who cannot tell whether it is live.

**Does the code deploy safely both before and after?**
Old code must tolerate the new schema, and new code must tolerate the old one
until the migration has run everywhere.

**What happens if it fails halfway?**
Name the state the database is left in, and how someone on call recovers from
it at 3am with no context.
