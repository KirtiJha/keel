import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const COMPACT_BYTES = 128 * 1024;

export function statePath(root: string): string {
  return join(keelDir(root), "tdd-state.json");
}

/** Append-only record of updates made since the snapshot was written. */
export function journalPath(root: string): string {
  return join(keelDir(root), "tdd-state.log");
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

function applyEntry(state: TddState, entry: JournalEntry): TddState {
  const branches: Record<string, BranchState> = { ...state.branches };

  if (entry.kind === "cleared") {
    delete branches[entry.branch];
    return { version: 1, branches };
  }

  const current = branches[entry.branch] ?? EMPTY_BRANCH;

  if (entry.kind === "implemented") {
    branches[entry.branch] = {
      ...current,
      implemented: [...new Set([...current.implemented, ...entry.keys])],
    };
    return { version: 1, branches };
  }

  const expectations: Record<string, TestExpectation> = { ...current.expectations };
  for (const file of entry.files) {
    const existing = expectations[file];
    expectations[file] =
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
            failingTests: [...new Set([...(existing?.failingTests ?? []), ...entry.failingTests])],
          };
  }
  branches[entry.branch] = { ...current, expectations };
  return { version: 1, branches };
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

let tempOrdinal = 0;

/**
 * Replace a file's contents in one step.
 *
 * `rename` is atomic on the same filesystem, so a concurrent reader sees the
 * whole previous file or the whole new one — never the half-written middle
 * that a plain `writeFileSync` exposes.
 */
function writeAtomic(target: string, contents: string): void {
  const temp = `${target}.${process.pid}.${tempOrdinal++}.tmp`;
  try {
    writeFileSync(temp, contents, "utf8");
    renameSync(temp, target);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing further to try; the previous snapshot is still intact.
    }
  }
}

/**
 * Fold a long journal into the snapshot.
 *
 * The journal is rotated with `rename` *before* it is read, so an appender
 * either got in before the rotation — and is therefore in the file being
 * folded — or appends to the fresh journal that replaces it. The second read
 * catches the one appender that could have been mid-call across the rename.
 */
function compactIfLarge(root: string): void {
  try {
    if (statSync(journalPath(root)).size < COMPACT_BYTES) return;
  } catch {
    return;
  }

  const rotated = `${journalPath(root)}.${process.pid}.${tempOrdinal++}.rotated`;
  try {
    renameSync(journalPath(root), rotated);
  } catch {
    // Another process rotated first. Its compaction covers these records.
    return;
  }

  try {
    const entries = readJournalFile(rotated);
    let folded = entries.reduce(applyEntry, readSnapshot(root));
    writeAtomic(statePath(root), `${JSON.stringify(folded, null, 2)}\n`);

    const recheck = readJournalFile(rotated);
    if (recheck.length > entries.length) {
      folded = recheck.slice(entries.length).reduce(applyEntry, folded);
      writeAtomic(statePath(root), `${JSON.stringify(folded, null, 2)}\n`);
    }
    rmSync(rotated, { force: true });
  } catch {
    // Leave the rotated file behind rather than lose it: the next compaction
    // has nothing to do with it, but no record was thrown away either.
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

export function readState(root: string): TddState {
  return readJournalFile(journalPath(root)).reduce(applyEntry, readSnapshot(root));
}

/**
 * Replace the whole ledger.
 *
 * Only for callers that own the file outright (`keel doctor --reset-tdd`), and
 * the journal goes with it: records describe changes *since* the snapshot, so
 * keeping them would resurrect what was just replaced.
 */
export function writeState(root: string, state: TddState): void {
  try {
    mkdirSync(keelDir(root), { recursive: true });
    writeAtomic(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
    rmSync(journalPath(root), { force: true });
  } catch {
    // Gate 3 degrades to "no observation recorded" rather than breaking the edit.
  }
}

export function branchState(state: TddState, branch: string): BranchState {
  return state.branches[branch] ?? EMPTY_BRANCH;
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

/** Record that implementation of a symbol was allowed, so gate 3 stops asking. */
export function recordImplemented(root: string, key: string): void {
  append(root, { kind: "implemented", branch: currentBranch(root), keys: [key] });
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
export function redObservedFor(root: string, testFile: string): RedStatus {
  const state = branchState(readState(root), currentBranch(root));
  const expectation = state.expectations[testFile];

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

export function isImplemented(root: string, key: string): boolean {
  return branchState(readState(root), currentBranch(root)).implemented.includes(key);
}

/**
 * Drop a branch's state. Called on merge or by `keel doctor --reset-tdd`.
 *
 * Journalled like every other update, so it neither clobbers a concurrent
 * write nor loses one that lands after it.
 */
export function clearBranch(root: string, branch: string): void {
  append(root, { kind: "cleared", branch });
}
