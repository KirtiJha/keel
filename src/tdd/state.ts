import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { exec } from "../shared/exec.js";
import { currentBranch } from "../shared/git.js";
import { keelDir } from "../shared/paths.js";

/**
 * `.keel/tdd-state.json` — the ledger behind gate 3 (observed RED).
 *
 * State is per branch (M6): a branch is the unit of work, and carrying
 * observations across branches would let a RED seen on one piece of work
 * authorise implementation on another.
 *
 * The design constraint that matters: a developer who writes a test, runs it,
 * watches it fail and then implements must never notice this exists. Every
 * transition below is driven by something such a developer already does.
 *
 * **Why a snapshot plus a journal.** Hooks run once per tool call and Claude
 * Code issues tool calls in parallel, so several processes update this file at
 * the same instant. Read-modify-write over one JSON file loses those updates —
 * measured at 8 concurrent writers, 300 of 320 expectations vanished and one
 * process read back an empty file immediately after writing it. A lost RED is
 * not a cosmetic bug: gate 3 then blocks an edit the developer already earned.
 *
 * So updates never rewrite the file. Each one appends a record to
 * `.keel/tdd-state.log` with `O_APPEND`, which the kernel places at the end of
 * the file as one atomic act, and readers fold the records over the snapshot.
 * There is no lock to deadlock, nothing to leave stale, and a failed append
 * degrades to "no observation recorded" — never to a block. The snapshot is
 * only ever replaced by an atomic write-then-rename, so a reader sees either
 * the whole old file or the whole new one.
 *
 * **Three properties this module has to keep, each of which it once lost.**
 *
 * 1. *Reading is linear.* The fold used to rebuild the whole expectations map
 *    per record, which made folding N records cost O(N²), and the gate runner
 *    read the ledger once per new exported symbol on top of that. A 20-symbol
 *    edit over a 120 KB journal took 40 s against a 600 ms budget and a 30 s
 *    platform timeout, so the hook was killed and gate 3 reached no verdict at
 *    all. The fold now mutates one accumulator, and callers that ask several
 *    questions read once — see `readBranchLedger`.
 *
 * 2. *Compaction cannot lose records.* `writeAtomic` makes each write atomic;
 *    it does nothing for the read-fold-write *sequence*. Two overlapping
 *    compactions each discarded the other's records — after the journal they
 *    came from had already been deleted. Measured, with no instrumentation: 8
 *    writers × 400 records in, 2292 out. Compaction now runs under an exclusive
 *    lock, folds a journal it has renamed out of the way first, and deletes
 *    that file only once the snapshot it produced is safely on disk. Every
 *    failure degrades to "leave the journal alone".
 *
 * 3. *It is bounded.* Nothing pruned this file in production, so it accumulated
 *    every test file ever recorded on every branch ever used — which is what
 *    fed (1). Compaction is the only step that rewrites the snapshot, so it is
 *    where the retention policy is applied. See `MAX_BRANCHES`.
 */

export interface TestExpectation {
  /** Epoch ms when the test file was last written. */
  readonly writtenAt: number;
  /** Epoch ms when a run was observed failing, or null if never. */
  readonly redObservedAt: number | null;
  /** Test names seen failing, when the runner's output named them. */
  readonly failingTests: readonly string[];
}

export interface BranchState {
  /** Keyed by repo-relative test file path. */
  readonly expectations: Readonly<Record<string, TestExpectation>>;
  /** `file#symbol` entries already allowed through, so a gate never re-fires. */
  readonly implemented: readonly string[];
}

export interface TddState {
  readonly version: 1;
  readonly branches: Readonly<Record<string, BranchState>>;
}

const EMPTY_BRANCH: BranchState = { expectations: {}, implemented: [] };
const EMPTY_STATE: TddState = { version: 1, branches: {} };

/** Fold the journal into the snapshot once it passes this size. */
export const COMPACT_BYTES = 128 * 1024;

/**
 * Retention policy, applied whenever the snapshot is rewritten.
 *
 * There is no production caller that prunes this file — `keel doctor` has no
 * reset flag — so without a policy it grows for the life of the checkout, and
 * every hook then pays to read it. The bounds are far above what real work
 * produces (this repository has fewer than 50 test files) and are ordered by
 * recency, so what a developer is working on right now is the last thing to go.
 *
 * Stale branches go first and cost nothing to lose: a branch that git no longer
 * has is a branch nobody can be mid-RED on. The numeric caps are the backstop
 * for the case git cannot answer, and they bound the file at roughly a megabyte
 * — small enough that parsing it stays off the hook's critical path.
 */
export const MAX_BRANCHES = 20;
/** Test files retained across the whole ledger, most recently touched first. */
export const MAX_EXPECTATIONS = 5000;
/** `file#symbol` records retained across the whole ledger, newest first. */
export const MAX_IMPLEMENTED = 5000;
/** Failing test names kept per test file: enough to explain, not to accumulate. */
const MAX_FAILING_TESTS = 50;

/**
 * How long a compaction lock may sit before another process may break it.
 *
 * Only reached when a process died holding it. Comfortably longer than any
 * compaction (milliseconds) and than the platform's own 30 s hook timeout, so a
 * live holder is never mistaken for a dead one.
 */
const LOCK_STALE_MS = 60_000;

export function statePath(root: string): string {
  return join(keelDir(root), "tdd-state.json");
}

/** Append-only record of updates made since the snapshot was written. */
export function journalPath(root: string): string {
  return join(keelDir(root), "tdd-state.log");
}

/**
 * The journal a compaction has taken ownership of.
 *
 * One fixed name rather than a per-process one, because readers fold it: a
 * process that dies between the rename and the snapshot write leaves its
 * records here, and `readState` has to find them without scanning a directory
 * on every hook invocation. Only the lock holder ever creates it.
 */
function rotatedPath(root: string): string {
  return `${journalPath(root)}.rotating`;
}

function lockPath(root: string): string {
  return join(keelDir(root), "tdd-state.lock");
}

// ---------------------------------------------------------------------------
// Journal records
// ---------------------------------------------------------------------------

type JournalEntry =
  | { readonly kind: "written"; readonly branch: string; readonly files: readonly string[]; readonly at: number }
  | {
      readonly kind: "red";
      readonly branch: string;
      readonly files: readonly string[];
      readonly at: number;
      readonly failingTests: readonly string[];
    }
  | { readonly kind: "implemented"; readonly branch: string; readonly keys: readonly string[] }
  | { readonly kind: "cleared"; readonly branch: string };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Parse one journal line. A malformed record is skipped, never thrown. */
function parseEntry(line: string): JournalEntry | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A torn or truncated final line: the rest of the journal still counts.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const branch = typeof record["branch"] === "string" ? record["branch"] : null;
  if (branch === null) return null;
  const at = typeof record["at"] === "number" ? record["at"] : 0;

  switch (record["kind"]) {
    case "written":
      return { kind: "written", branch, files: stringList(record["files"]), at };
    case "red":
      return {
        kind: "red",
        branch,
        files: stringList(record["files"]),
        at,
        failingTests: stringList(record["failingTests"]),
      };
    case "implemented":
      return { kind: "implemented", branch, keys: stringList(record["keys"]) };
    case "cleared":
      return { kind: "cleared", branch };
    default:
      return null;
  }
}

function readJournalFile(path: string): JournalEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseEntry(line);
    if (entry !== null) out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/**
 * One branch, in the shape the fold mutates.
 *
 * A `Map` and a `Set` rather than an object and an array on purpose: applying a
 * record has to be O(1). The immutable shapes above are what callers see, and
 * they are built once at the end rather than once per record — that difference
 * is the whole of regression 1.
 */
interface MutableBranch {
  readonly expectations: Map<string, TestExpectation>;
  readonly implemented: Set<string>;
}

function emptyMutable(): MutableBranch {
  return { expectations: new Map(), implemented: new Set() };
}

function toMutable(state: BranchState): MutableBranch {
  return {
    expectations: new Map(Object.entries(state.expectations)),
    implemented: new Set(state.implemented),
  };
}

function toBranchState(branch: MutableBranch): BranchState {
  return {
    expectations: Object.fromEntries(branch.expectations),
    implemented: [...branch.implemented],
  };
}

function mergeFailing(
  existing: readonly string[] | undefined,
  incoming: readonly string[],
): readonly string[] {
  if (incoming.length === 0) return existing ?? [];
  const merged = new Set(existing ?? []);
  for (const name of incoming) merged.add(name);
  const out = [...merged];
  // Bounded: a long-lived expectation must not accumulate a name per run.
  return out.length > MAX_FAILING_TESTS ? out.slice(out.length - MAX_FAILING_TESTS) : out;
}

/** Apply one record to one branch, in place. Never allocates the whole map. */
function applyToBranch(branch: MutableBranch, entry: JournalEntry): void {
  if (entry.kind === "cleared") {
    branch.expectations.clear();
    branch.implemented.clear();
    return;
  }

  if (entry.kind === "implemented") {
    for (const key of entry.keys) branch.implemented.add(key);
    return;
  }

  for (const file of entry.files) {
    const existing = branch.expectations.get(file);
    branch.expectations.set(
      file,
      entry.kind === "written"
        ? {
            // The prior RED observation is *kept*, not cleared. See
            // `recordTestWritten` for why ordering, not presence, decides.
            writtenAt: entry.at,
            redObservedAt: existing?.redObservedAt ?? null,
            failingTests: existing?.failingTests ?? [],
          }
        : {
            writtenAt: existing?.writtenAt ?? entry.at,
            redObservedAt: entry.at,
            failingTests: mergeFailing(existing?.failingTests, entry.failingTests),
          },
    );
  }
}

/** Fold every record over the snapshot. Linear in the number of records. */
function foldAll(snapshot: TddState, entries: readonly JournalEntry[]): TddState {
  if (entries.length === 0) return snapshot;

  const branches = new Map<string, MutableBranch>();
  for (const [name, state] of Object.entries(snapshot.branches)) {
    branches.set(name, toMutable(normaliseBranch(state)));
  }

  for (const entry of entries) {
    if (entry.kind === "cleared") {
      branches.delete(entry.branch);
      continue;
    }
    let branch = branches.get(entry.branch);
    if (branch === undefined) {
      branch = emptyMutable();
      branches.set(entry.branch, branch);
    }
    applyToBranch(branch, entry);
  }

  const out: Record<string, BranchState> = {};
  for (const [name, branch] of branches) out[name] = toBranchState(branch);
  return { version: 1, branches: out };
}

/**
 * Fold only the records that belong to `branch`.
 *
 * Gate 3 only ever asks about the branch it is on, and skipping the other
 * branches keeps the cost proportional to the work in front of the developer
 * rather than to everything the checkout has ever done.
 */
function foldBranch(snapshot: TddState, entries: readonly JournalEntry[], branch: string): MutableBranch {
  const accumulator = toMutable(branchState(snapshot, branch));
  for (const entry of entries) {
    if (entry.branch !== branch) continue;
    applyToBranch(accumulator, entry);
  }
  return accumulator;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

let tempOrdinal = 0;

/**
 * Replace a file's contents in one step, reporting whether it worked.
 *
 * `rename` is atomic on the same filesystem, so a concurrent reader sees the
 * whole previous file or the whole new one — never the half-written middle that
 * a plain `writeFileSync` exposes.
 *
 * It returns a boolean because it used to swallow its own failure: compaction
 * then deleted the journal the snapshot was folded from even when that snapshot
 * had never reached disk, turning one failed write into permanent data loss.
 * Nothing here throws — a hook must not fail over bookkeeping — so the caller
 * has no other way to find out.
 */
function writeAtomic(target: string, contents: string): boolean {
  const temp = `${target}.${process.pid}.${tempOrdinal++}.tmp`;
  try {
    writeFileSync(temp, contents, "utf8");
    renameSync(temp, target);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing further to try; the previous snapshot is still intact.
    }
    return false;
  }
}

function serialise(state: TddState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Take the compaction lock, or report that someone else has it.
 *
 * Never waits and never throws: a hook that blocks on a lock is worse than a
 * hook that skips an optimisation. Losing the race costs nothing — the records
 * stay in the journal and the next compaction folds them.
 *
 * `wx` is the atomic part: exactly one process can create the file. A lock left
 * behind by a process that died is broken open after `LOCK_STALE_MS`.
 */
function acquireLock(root: string): boolean {
  const path = lockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch {
      const stat = (() => {
        try {
          return statSync(path);
        } catch {
          return null;
        }
      })();
      // It vanished between the two calls: the holder finished, so try again.
      if (stat === null) continue;
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock(root: string): void {
  try {
    unlinkSync(lockPath(root));
  } catch {
    // Already gone, or never ours to remove. Either way the next compaction
    // either takes it cleanly or breaks it open as stale.
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Branches git still has, or null when git could not answer. */
function liveBranches(root: string): Set<string> | null {
  const res = exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: root,
  });
  if (!res.ok || res.value.code !== 0) return null;
  const out = new Set<string>();
  for (const line of res.value.stdout.split("\n")) {
    const name = line.trim();
    if (name !== "") out.add(name);
  }
  return out;
}

function expectationRecency(expectation: TestExpectation): number {
  return Math.max(expectation.writtenAt, expectation.redObservedAt ?? 0);
}

function branchRecency(state: BranchState): number {
  let newest = 0;
  for (const expectation of Object.values(state.expectations)) {
    const at = expectationRecency(expectation);
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Apply the retention policy.
 *
 * Never throws and never drops the current branch: the branch the developer is
 * on is the one whose RED they may be about to spend. When git cannot list
 * branches the existence rule is skipped entirely and only the numeric caps
 * apply — an unestablished fact is not grounds for deleting someone's evidence.
 */
function prune(root: string, state: TddState, branch: string): TddState {
  const live = liveBranches(root);

  const kept = Object.entries(state.branches)
    .map(([name, raw]) => ({ name, state: normaliseBranch(raw) }))
    .filter((entry) => entry.name === branch || live === null || live.has(entry.name))
    .sort((a, b) => branchRecency(b.state) - branchRecency(a.state));

  // The current branch is never the one dropped for being over the count.
  const withinCount = kept
    .filter((entry) => entry.name !== branch)
    .slice(0, Math.max(0, MAX_BRANCHES - 1));
  const current = kept.find((entry) => entry.name === branch);
  const ordered = current === undefined ? withinCount : [current, ...withinCount];

  // Global caps, newest first, so the records a developer is working through
  // outlive the ones they finished with weeks ago.
  const expectationBudget = allocate(
    ordered.map((entry) =>
      Object.entries(entry.state.expectations).sort(
        (a, b) => expectationRecency(a[1]) - expectationRecency(b[1]),
      ),
    ),
    MAX_EXPECTATIONS,
  );
  // `implemented` has no timestamp of its own; it is append-ordered, so its
  // tail is its newest.
  const implementedBudget = allocate(
    ordered.map((entry) => entry.state.implemented),
    MAX_IMPLEMENTED,
  );

  const branches: Record<string, BranchState> = {};
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    if (entry === undefined) continue;
    branches[entry.name] = {
      expectations: Object.fromEntries(expectationBudget[i] ?? []),
      implemented: implementedBudget[i] ?? [],
    };
  }
  return { version: 1, branches };
}

/**
 * Share `budget` records across branches, taking from the tail (the newest) of
 * each in turn so no single branch can starve the others.
 */
function allocate<T>(perBranch: readonly (readonly T[])[], budget: number): T[][] {
  const taken: T[][] = perBranch.map(() => []);
  let remaining = budget;
  let progressed = true;

  while (remaining > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < perBranch.length && remaining > 0; i++) {
      const source = perBranch[i] ?? [];
      const out = taken[i] ?? [];
      if (out.length >= source.length) continue;
      const item = source[source.length - 1 - out.length];
      if (item === undefined) continue;
      out.push(item);
      remaining--;
      progressed = true;
    }
  }

  // Restore each branch's original (oldest-first) order.
  return taken.map((list) => list.reverse());
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Fold the journal this process has taken ownership of into the snapshot.
 *
 * Only ever called under the lock. The rotated file is removed *after* the
 * snapshot it produced is on disk, never before: the previous ordering meant a
 * failed write deleted the only copy of those records.
 */
function foldRotated(root: string, branch: string): void {
  const rotated = rotatedPath(root);

  // The rename moved the file out from under new appenders, but a process that
  // had already opened the old inode still writes into it. Folding between the
  // two reads leaves time for that write to land, and the second read picks it
  // up.
  const first = readJournalFile(rotated);
  let folded = foldAll(readSnapshot(root), first);
  const second = readJournalFile(rotated);
  if (second.length > first.length) folded = foldAll(folded, second.slice(first.length));

  if (!writeAtomic(statePath(root), serialise(prune(root, folded, branch)))) {
    // Leave the rotated file exactly where it is. `readState` folds it, so no
    // observation is lost, and the next compaction retries the write.
    return;
  }
  try {
    rmSync(rotated, { force: true });
  } catch {
    // Harmless: it is now a duplicate of what the snapshot already contains,
    // and folding it again is idempotent.
  }
}

/**
 * Fold a long journal into the snapshot.
 *
 * Two things make this safe under concurrency. The lock serialises the whole
 * read-fold-write sequence, which `writeAtomic` alone never could — overlapping
 * compactions used to discard each other's records. And the journal is renamed
 * out of the way *before* it is read, so an appender either got in before the
 * rename, and is in the file being folded, or appends to the fresh journal that
 * replaces it.
 *
 * Every failure path leaves the journal alone. That is the invariant: a
 * compaction that cannot finish must cost nothing but the disk space it would
 * have saved.
 */
function compactIfLarge(root: string): void {
  const leftover = fileSize(rotatedPath(root)) !== null;
  const large = (fileSize(journalPath(root)) ?? 0) >= COMPACT_BYTES;
  if (!leftover && !large) return;

  // Losing the race is not a failure: the records stay in the journal and the
  // process that holds the lock, or the next one, folds them.
  if (!acquireLock(root)) return;

  try {
    const branch = currentBranch(root);

    // A rotation an earlier compaction never finished — it crashed, or the
    // snapshot write failed. Its records are still being read, because
    // `readState` folds this file, but they belong in the snapshot.
    if (fileSize(rotatedPath(root)) !== null) {
      foldRotated(root, branch);
      // Still there, so the snapshot still cannot be written. Rotating the
      // journal on top of it would overwrite records that never reached the
      // snapshot — one failed write turning into silent data loss, which is
      // the whole failure mode this rewrite exists to remove.
      if (fileSize(rotatedPath(root)) !== null) return;
    }

    if ((fileSize(journalPath(root)) ?? 0) < COMPACT_BYTES) return;
    try {
      renameSync(journalPath(root), rotatedPath(root));
    } catch {
      // Nothing to rotate, or the journal vanished under us. Either way there
      // is no work to do and nothing has been lost.
      return;
    }
    foldRotated(root, branch);
  } catch {
    // Bookkeeping must never break an edit. The journal is either untouched or
    // sitting in the rotated file, which readers fold.
  } finally {
    releaseLock(root);
  }
}

/** Append one record. Never throws: a hook must not fail over bookkeeping. */
function append(root: string, entry: JournalEntry): void {
  try {
    mkdirSync(keelDir(root), { recursive: true });
    appendFileSync(journalPath(root), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Gate 3 degrades to "no observation recorded" rather than breaking the edit.
    return;
  }
  compactIfLarge(root);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The snapshot alone, without the journal folded in. */
function readSnapshot(root: string): TddState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(root), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;
    const state = parsed as Partial<TddState>;
    if (state.version !== 1 || typeof state.branches !== "object" || state.branches === null) {
      return EMPTY_STATE;
    }
    return { version: 1, branches: state.branches };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * Every record not yet in the snapshot, oldest first.
 *
 * The rotated journal comes first because it is older by construction: it was
 * renamed away before the records now in the live journal were written. Folding
 * it again when the snapshot already contains it is harmless — the same records
 * in the same order produce the same state.
 */
function pendingEntries(root: string): JournalEntry[] {
  const rotated = readJournalFile(rotatedPath(root));
  const journal = readJournalFile(journalPath(root));
  if (rotated.length === 0) return journal;
  if (journal.length === 0) return rotated;
  return [...rotated, ...journal];
}

export function readState(root: string): TddState {
  const entries = pendingEntries(root);
  // The common case, immediately after a compaction: one `JSON.parse` and done.
  if (entries.length === 0) return readSnapshot(root);
  return foldAll(readSnapshot(root), entries);
}

/**
 * Replace the whole ledger.
 *
 * Only for a caller that owns the file outright — a manual reset — and the
 * journal goes with it: records describe changes *since* the snapshot, so
 * keeping them would resurrect what was just replaced. Nothing in the plugin
 * calls this today; the CLI has no reset command to hang it off.
 */
export function writeState(root: string, state: TddState): void {
  try {
    mkdirSync(keelDir(root), { recursive: true });
    // Order matters: dropping the journal before the snapshot is safely on disk
    // discards records that the replacement never captured.
    if (!writeAtomic(statePath(root), serialise(state))) return;
    rmSync(journalPath(root), { force: true });
    rmSync(rotatedPath(root), { force: true });
  } catch {
    // Gate 3 degrades to "no observation recorded" rather than breaking the edit.
  }
}

/** One branch's state, tolerating a snapshot that has been hand-edited. */
function normaliseBranch(state: BranchState | undefined): BranchState {
  if (state === undefined || typeof state !== "object" || state === null) return EMPTY_BRANCH;
  const expectations =
    typeof state.expectations === "object" && state.expectations !== null ? state.expectations : {};
  const implemented = Array.isArray(state.implemented) ? state.implemented : [];
  if (expectations === state.expectations && implemented === state.implemented) return state;
  return { expectations, implemented };
}

export function branchState(state: TddState, branch: string): BranchState {
  return normaliseBranch(state.branches[branch]);
}

/**
 * Record that a test file was written.
 *
 * The prior RED observation is *kept*, not cleared. Ordering is what decides
 * validity — `redObservedAt < writtenAt` means the failing run predates the
 * current test — and keeping the timestamp lets `redObservedFor` say which of
 * the two situations a developer is in. Clearing it would collapse "you have
 * not run this yet" and "you edited the test after running it" into one
 * unhelpful message.
 */
export function recordTestWritten(root: string, testFile: string, now = Date.now()): void {
  append(root, { kind: "written", branch: currentBranch(root), files: [testFile], at: now });
}

/** Record that a run was observed failing for these test files. */
export function recordRedObserved(
  root: string,
  testFiles: readonly string[],
  failingTests: readonly string[],
  now = Date.now(),
): void {
  if (testFiles.length === 0) return;
  append(root, {
    kind: "red",
    branch: currentBranch(root),
    files: [...testFiles],
    at: now,
    failingTests: [...failingTests],
  });
}

/**
 * Record that implementation of some symbols was allowed, so gate 3 stops
 * asking about them.
 *
 * Takes the whole set in one call because the gate runner has the whole set:
 * one record, one `git rev-parse`, one append. Recording them one at a time cost
 * a subprocess and a file write per symbol on the hot path.
 */
export function recordImplementedAll(root: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  append(root, { kind: "implemented", branch: currentBranch(root), keys: [...keys] });
}

export function recordImplemented(root: string, key: string): void {
  recordImplementedAll(root, [key]);
}

export interface RedStatus {
  readonly observed: boolean;
  readonly testFile: string | null;
  readonly reason: string;
}

/**
 * Has a RED been observed for `testFile` since it was last written?
 *
 * The ordering check is the whole gate: a failing run recorded *before* the
 * current version of the test proves nothing about the current version.
 */
function redStatus(expectation: TestExpectation | undefined, testFile: string): RedStatus {
  if (expectation === undefined) {
    return { observed: false, testFile, reason: "no test run has been recorded for this test file" };
  }
  if (expectation.redObservedAt === null) {
    return { observed: false, testFile, reason: "the test has not been seen failing yet" };
  }
  if (expectation.redObservedAt < expectation.writtenAt) {
    return {
      observed: false,
      testFile,
      reason: "the test was edited after the last failing run, so the current test has never been seen red",
    };
  }
  return { observed: true, testFile, reason: "red observed" };
}

/**
 * The current branch's ledger, read once.
 *
 * Every question the gate runner asks — "is this symbol already waved through",
 * "has this test been seen red" — is answered from this one read. Asking them
 * through the free functions below re-read and re-folded the whole file per
 * question, which is how a hook with a 600 ms budget came to take 40 s.
 */
export interface BranchLedger {
  readonly branch: string;
  /** Has this `file#symbol` already been allowed through on this branch? */
  isImplemented(key: string): boolean;
  /** Has a RED been observed for this test file since it was last written? */
  redObservedFor(testFile: string): RedStatus;
}

export function readBranchLedger(root: string): BranchLedger {
  const branch = currentBranch(root);
  const state = foldBranch(readSnapshot(root), pendingEntries(root), branch);
  return {
    branch,
    isImplemented: (key) => state.implemented.has(key),
    redObservedFor: (testFile) => redStatus(state.expectations.get(testFile), testFile),
  };
}

export function redObservedFor(root: string, testFile: string): RedStatus {
  return readBranchLedger(root).redObservedFor(testFile);
}

export function isImplemented(root: string, key: string): boolean {
  return readBranchLedger(root).isImplemented(key);
}

/**
 * Drop a branch's state, for example when its work has been merged.
 *
 * Journalled like every other update, so it neither clobbers a concurrent write
 * nor loses one that lands after it. Nothing in the plugin calls this today —
 * branches that git no longer has are dropped by the retention policy instead.
 */
export function clearBranch(root: string, branch: string): void {
  append(root, { kind: "cleared", branch });
}
