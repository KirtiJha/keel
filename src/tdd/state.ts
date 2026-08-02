import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function statePath(root: string): string {
  return join(keelDir(root), "tdd-state.json");
}

export function readState(root: string): TddState {
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

export function writeState(root: string, state: TddState): void {
  try {
    mkdirSync(keelDir(root), { recursive: true });
    writeFileSync(statePath(root), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Gate 3 degrades to "no observation recorded" rather than breaking the edit.
  }
}

export function branchState(state: TddState, branch: string): BranchState {
  return state.branches[branch] ?? EMPTY_BRANCH;
}

export function updateBranch(
  root: string,
  branch: string,
  update: (current: BranchState) => BranchState,
): BranchState {
  const state = readState(root);
  const next = update(branchState(state, branch));
  writeState(root, { version: 1, branches: { ...state.branches, [branch]: next } });
  return next;
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
  const branch = currentBranch(root);
  updateBranch(root, branch, (current) => {
    const existing = current.expectations[testFile];
    return {
      ...current,
      expectations: {
        ...current.expectations,
        [testFile]: {
          writtenAt: now,
          redObservedAt: existing?.redObservedAt ?? null,
          failingTests: existing?.failingTests ?? [],
        },
      },
    };
  });
}

/** Record that a run was observed failing for these test files. */
export function recordRedObserved(
  root: string,
  testFiles: readonly string[],
  failingTests: readonly string[],
  now = Date.now(),
): void {
  if (testFiles.length === 0) return;
  const branch = currentBranch(root);

  updateBranch(root, branch, (current) => {
    const expectations = { ...current.expectations };
    for (const file of testFiles) {
      const existing = expectations[file];
      expectations[file] = {
        writtenAt: existing?.writtenAt ?? now,
        redObservedAt: now,
        failingTests: [...new Set([...(existing?.failingTests ?? []), ...failingTests])],
      };
    }
    return { ...current, expectations };
  });
}

/** Record that implementation of a symbol was allowed, so gate 3 stops asking. */
export function recordImplemented(root: string, key: string): void {
  const branch = currentBranch(root);
  updateBranch(root, branch, (current) => ({
    ...current,
    implemented: [...new Set([...current.implemented, key])],
  }));
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

/** Drop a branch's state. Called on merge or by `keel doctor --reset-tdd`. */
export function clearBranch(root: string, branch: string): void {
  const state = readState(root);
  const branches = { ...state.branches };
  delete branches[branch];
  writeState(root, { version: 1, branches });
}
