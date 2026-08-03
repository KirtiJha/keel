import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { KeelConfig } from "../shared/config.js";
import { logDebug } from "../shared/log.js";
import { keelDir, toRepoRelative } from "../shared/paths.js";
import { errorMessage, type Result, err, ok } from "../shared/result.js";

import { type LoadedPack, loadPacks } from "./loader.js";
import type { PackMode } from "./schema.js";

/**
 * The trust boundary for standards packs.
 *
 * **A pack rule is code, and running it is a decision.** `rule.ts` / `rule.py`
 * are imported and executed in-process by the PostToolUse hook with the full
 * privileges of the developer's session — they can read any file, spawn any
 * process, and reach the network. Nothing about the pack format sandboxes them.
 *
 * That is fine for the packs shipped inside the plugin: they arrive with Keel
 * itself and are trusted by construction. It is *not* fine for a pack found in
 * the repository being edited. `standards.dirs` defaults to `["standards"]`, so
 * cloning an untrusted repo, opening it, and letting Claude edit one matching
 * file was enough to execute that repo's code. No config, no prompt, no notice.
 *
 * So a repo-local rule runs only after an explicit, per-repo approval keyed to
 * the exact bytes of the rule file. Editing an approved rule invalidates the
 * approval — trust is in the content, never in the path.
 *
 * ## Why the record is signed
 *
 * The record lives in the repository, at `.keel/trust.json`, so it is visible
 * and reviewable next to the packs it approves. But a hostile repo can *commit*
 * that file, and a self-approving trust record would be no gate at all. Every
 * record therefore carries an HMAC over (repo root, pack, rule path, rule hash)
 * using a random key stored outside any repository, in `KEEL_HOME` or
 * `~/.keel/machine-key`. A record that did not come from this machine's `keel
 * trust` does not verify, and the rule does not run.
 *
 * ## Failure is always "do not run", never "do not edit"
 *
 * Every negative answer here — unreadable rule, missing key, corrupt store —
 * degrades to "this pack does not run and says so". A gate that cannot decide
 * must not block a developer's edit (constraint 0.3).
 *
 * ## Exported contract, for the CLI to wire up
 *
 * Hooks must never prompt, so approval belongs to a human-driven command
 * (`src/cli/` owns the wiring; this module owns the mechanism):
 *
 *   - `listUntrustedRules(scope)` — every repo-local rule that will not run,
 *     with the repo-relative file to read, its sha256, and why it is untrusted
 *     (`never approved` vs `changed since approval`). Show these, let the human
 *     read the file, then approve by name.
 *   - `trustRule(scope, packName)` — record approval for every rule file in one
 *     pack, at their current contents. Returns the records written, or an error
 *     string that is already phrased for a terminal.
 *   - `untrustRule(repoRoot, packName)` — revoke; returns how many records went.
 *   - `ruleTrust(repoRoot, pluginRoot, pack, ruleFile)` — the single decision
 *     the runner and the rule loader call. Exported so `keel doctor` can report
 *     the same verdict the hook will reach.
 *
 * `scope` is `{ repoRoot, pluginRoot, config }` — the three values every CLI
 * command already holds.
 */

/** Where the per-repo approvals live, relative to the repo's `.keel/`. */
export const TRUST_FILE = "trust.json";

/** Machine-scoped Keel state, outside any repository. Overridable for tests. */
export function machineDir(): string | null {
  const override = process.env["KEEL_HOME"];
  if (override !== undefined && override.trim() !== "") return resolve(override);
  try {
    const home = homedir();
    return home === "" ? null : join(home, ".keel");
  } catch {
    return null;
  }
}

let keyCache: { readonly path: string; readonly key: Buffer } | null = null;

/**
 * The machine's signing key, created on first use.
 *
 * `create` is false on every read path: verifying a record must not have the
 * side effect of writing to the user's home directory.
 */
function machineKey(create: boolean): Buffer | null {
  const dir = machineDir();
  if (dir === null) return null;
  const path = join(dir, "machine-key");

  if (keyCache !== null && keyCache.path === path) return keyCache.key;

  const existing = readKey(path);
  if (existing !== null) {
    keyCache = { path, key: existing };
    return existing;
  }
  if (!create) return null;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      writeFileSync(path, key, { mode: 0o600, flag: "wx" });
    } catch {
      // Another hook created it between our read and our write; theirs wins.
      const raced = readKey(path);
      if (raced === null) return null;
      keyCache = { path, key: raced };
      return raced;
    }
    keyCache = { path, key };
    return key;
  } catch (cause) {
    logDebug("machine key unavailable", { error: errorMessage(cause) });
    return null;
  }
}

function readKey(path: string): Buffer | null {
  try {
    const key = readFileSync(path);
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

/**
 * HMAC over `parts` with the machine key, or null when there is no key.
 *
 * Also used by the compiled-rule cache: an artifact that this machine did not
 * produce is not evidence of anything.
 */
export function machineMac(parts: readonly string[], create = false): string | null {
  const key = machineKey(create);
  if (key === null) return null;
  const mac = createHmac("sha256", key);
  for (const part of parts) {
    mac.update(part);
    // NUL-separated: a path may contain spaces, and ["a b", "c"] must not
    // hash the same as ["a", "b c"].
    mac.update("\u0000");
  }
  return mac.digest("hex");
}

/** Constant-time comparison of two hex digests of the same length. */
export function macEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null || a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function sha256Bytes(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function sha256File(path: string): string | null {
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return null;
  }
}

export interface TrustRecord {
  readonly pack: string;
  /** Repo-relative path of the approved rule file. */
  readonly file: string;
  /** sha256 of the exact bytes approved. */
  readonly sha256: string;
  readonly approvedAt: string;
  /** HMAC binding the record to this machine. */
  readonly mac: string;
}

interface TrustStore {
  readonly version: 1;
  readonly rules: readonly TrustRecord[];
}

const EMPTY_STORE: TrustStore = { version: 1, rules: [] };

function trustPath(repoRoot: string): string {
  return join(keelDir(repoRoot), TRUST_FILE);
}

let storeCache: { readonly path: string; readonly mtimeMs: number; readonly store: TrustStore } | null =
  null;

function parseStore(path: string): TrustStore {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return EMPTY_STORE;
    const rules = (raw as { rules?: unknown }).rules;
    if (!Array.isArray(rules)) return EMPTY_STORE;
    const out: TrustRecord[] = [];
    for (const entry of rules) {
      if (typeof entry !== "object" || entry === null) continue;
      const r = entry as Partial<TrustRecord>;
      if (
        typeof r.pack !== "string" ||
        typeof r.file !== "string" ||
        typeof r.sha256 !== "string" ||
        typeof r.mac !== "string"
      ) {
        continue;
      }
      out.push({
        pack: r.pack,
        file: r.file,
        sha256: r.sha256,
        approvedAt: typeof r.approvedAt === "string" ? r.approvedAt : "",
        mac: r.mac,
      });
    }
    return { version: 1, rules: out };
  } catch {
    // A corrupt store approves nothing. It must not throw into a hook.
    return EMPTY_STORE;
  }
}

function readStore(repoRoot: string): TrustStore {
  const path = trustPath(repoRoot);
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Absent is the common case: nothing has ever been approved here.
  }
  if (storeCache !== null && storeCache.path === path && storeCache.mtimeMs === mtimeMs) {
    return storeCache.store;
  }
  const store = mtimeMs < 0 ? EMPTY_STORE : parseStore(path);
  storeCache = { path, mtimeMs, store };
  return store;
}

function writeStore(repoRoot: string, store: TrustStore): Result<true, string> {
  const path = trustPath(repoRoot);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(keelDir(repoRoot), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (cause) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort; the failure that matters is the one below.
    }
    return err(`could not write ${TRUST_FILE}: ${errorMessage(cause)}`);
  }
  storeCache = null;
  return ok(true);
}

/** Packs that ship inside the plugin are trusted by construction. */
export function isPluginPack(pack: LoadedPack, pluginRoot: string): boolean {
  const root = resolve(pluginRoot, "standards");
  const dir = resolve(pack.dir);
  return dir === root || dir.startsWith(`${root}${sep}`);
}

export type RuleTrust =
  | { readonly kind: "plugin" }
  | { readonly kind: "trusted"; readonly sha256: string }
  | {
      readonly kind: "untrusted";
      readonly reason: string;
      readonly sha256: string | null;
      /** True when an approval exists but no longer matches the file. */
      readonly changed: boolean;
    };

/**
 * Run repo-local rules without an approval, for callers where approval is
 * meaningless.
 *
 * **Why this exists.** Approval protects a *developer's machine* from a
 * repository they have merely opened: cloning something and letting Claude Code
 * edit one file should not execute that repository's code. CI is the opposite
 * situation. A CI job has already checked the repository out and is already
 * running its code — `npm ci` runs its install scripts, `npm test` runs its
 * tests. A pack rule is not a new privilege there, and there is no human at a
 * terminal to grant one.
 *
 * Without this, the two fixes cancel out: `keel gate` in CI reports every
 * repo-local pack as unapproved and exits 1, telling a machine to run
 * `keel trust add` — advice it cannot take, because the approval is signed
 * against a key that does not survive the runner. The gates would be reachable
 * from CI in name only.
 *
 * It is a deliberate flag rather than a `CI=true` sniff. Environments set `CI`
 * for all sorts of reasons, and a security boundary that disables itself on a
 * variable someone else controls is not a boundary. Passing this is a choice a
 * human makes once, visibly, in a workflow file.
 */
export interface TrustOptions {
  /** Treat repo-local rules as approved. Only for a sandbox that already runs this repo's code. */
  readonly trustRepoRules?: boolean;
}

/**
 * May this rule file run?
 *
 * The one decision point. Both the TypeScript loader and the Python runner call
 * it, so there is no path to execution that skips it.
 *
 * `contents` lets a caller that has already read the file hand over the exact
 * bytes it is about to execute, so the approval covers those bytes rather than
 * whatever a second read might find.
 */
export function ruleTrust(
  repoRoot: string,
  pluginRoot: string,
  pack: LoadedPack,
  ruleFile: string,
  contents?: Buffer,
  options: TrustOptions = {},
): RuleTrust {
  if (isPluginPack(pack, pluginRoot)) return { kind: "plugin" };
  if (options.trustRepoRules === true) {
    const bytes = contents === undefined ? sha256File(ruleFile) : sha256Bytes(contents);
    return { kind: "trusted", sha256: bytes ?? "" };
  }

  const sha256 = contents === undefined ? sha256File(ruleFile) : sha256Bytes(contents);
  if (sha256 === null) {
    return { kind: "untrusted", reason: "the rule file could not be read", sha256: null, changed: false };
  }

  const file = toRepoRelative(repoRoot, ruleFile);
  const forFile = readStore(repoRoot).rules.filter(
    (r) => r.pack === pack.standard.name && r.file === file,
  );
  const match = forFile.find((r) => r.sha256 === sha256);

  if (match === undefined) {
    return {
      kind: "untrusted",
      sha256,
      changed: forFile.length > 0,
      reason:
        forFile.length > 0
          ? "the rule has changed since it was approved"
          : "this repo-local rule has never been approved",
    };
  }

  const expected = machineMac(macParts(repoRoot, pack.standard.name, file, sha256));
  if (expected === null) {
    return {
      kind: "untrusted",
      sha256,
      changed: false,
      reason: "no machine key is available, so the approval cannot be verified",
    };
  }
  if (!macEquals(match.mac, expected)) {
    return {
      kind: "untrusted",
      sha256,
      changed: false,
      // The interesting case: a repo that shipped its own `.keel/trust.json`.
      reason: "the approval was not written by this machine",
    };
  }

  return { kind: "trusted", sha256 };
}

/**
 * The repo root as the MAC sees it, with symlinks resolved.
 *
 * `resolve()` normalises `.` and `..` but leaves symlinks alone, and the two
 * sides of this check reach the root by different routes: `keel trust add`
 * derives it from `process.cwd()`, which the OS has already canonicalised,
 * while the hook derives it from whatever `cwd` string Claude Code passes. When
 * those differ by a symlink the MAC stops matching, and an approved repo-local
 * gate silently stops running — reporting "the approval was not written by this
 * machine", visible only under `KEEL_DEBUG`, and *unfixable*: re-running
 * `keel trust add` from the symlinked path writes a record signed against the
 * canonical root, so the hook keeps rejecting it.
 *
 * macOS hands out `/tmp` for `/private/tmp` and puts `$TMPDIR` under
 * `/var/folders`, so this is the common case there, not an exotic one.
 * `escapesRepo` in `../shared/paths.js` already resolves its root for exactly
 * this reason; that lesson belongs here too.
 */
function canonicalRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    // A root that cannot be resolved still needs a stable string, and both
    // sides will fail the same way — which is a rejected approval, not a
    // forged one.
    return resolve(repoRoot);
  }
}

function macParts(repoRoot: string, pack: string, file: string, sha256: string): string[] {
  return ["keel-rule-trust/1", canonicalRoot(repoRoot), pack, file, sha256];
}

export interface TrustScope {
  readonly repoRoot: string;
  readonly pluginRoot: string;
  readonly config: KeelConfig;
}

export interface UntrustedRule {
  readonly pack: string;
  readonly mode: PackMode;
  readonly owner: string;
  readonly description: string;
  /** Repo-relative path of the file a human should read before approving. */
  readonly file: string;
  /** sha256 of the current contents, or null when unreadable. */
  readonly sha256: string | null;
  readonly reason: string;
  /** True when this is a re-approval: the rule changed after being trusted. */
  readonly changed: boolean;
}

/**
 * Every repo-local rule that will not run until a human approves it.
 *
 * Sorted so `gate` packs — the ones that execute on every matching edit — come
 * first.
 */
export function listUntrustedRules(scope: TrustScope): UntrustedRule[] {
  const { packs } = loadPacks(scope.repoRoot, scope.pluginRoot, scope.config);
  const out: UntrustedRule[] = [];

  for (const pack of packs) {
    if (isPluginPack(pack, scope.pluginRoot)) continue;
    for (const ruleFile of ruleFilesOf(pack)) {
      const trust = ruleTrust(scope.repoRoot, scope.pluginRoot, pack, ruleFile);
      if (trust.kind !== "untrusted") continue;
      out.push({
        pack: pack.standard.name,
        mode: pack.standard.mode,
        owner: pack.standard.owner,
        description: pack.standard.description,
        file: toRepoRelative(scope.repoRoot, ruleFile),
        sha256: trust.sha256,
        reason: trust.reason,
        changed: trust.changed,
      });
    }
  }

  const rank = (mode: PackMode): number => (mode === "gate" ? 0 : 1);
  return out.sort((a, b) => rank(a.mode) - rank(b.mode) || a.pack.localeCompare(b.pack));
}

function ruleFilesOf(pack: LoadedPack): string[] {
  const files: string[] = [];
  if (pack.ruleTsPath !== null) files.push(pack.ruleTsPath);
  if (pack.rulePyPath !== null) files.push(pack.rulePyPath);
  return files;
}

/**
 * Approve every rule file in one pack, at its current contents.
 *
 * Errors are already phrased for a terminal — the CLI can print them verbatim.
 */
export function trustRule(scope: TrustScope, packName: string): Result<TrustRecord[], string> {
  const { packs } = loadPacks(scope.repoRoot, scope.pluginRoot, scope.config);
  const pack = packs.find((p) => p.standard.name === packName);
  if (pack === undefined) {
    return err(`no standards pack named \`${packName}\` is visible from this repository`);
  }
  if (isPluginPack(pack, scope.pluginRoot)) {
    return err(`\`${packName}\` ships with Keel itself and is already trusted`);
  }

  const files = ruleFilesOf(pack);
  if (files.length === 0) {
    return err(`\`${packName}\` has no rule.ts or rule.py, so there is nothing to approve`);
  }

  const approved: TrustRecord[] = [];
  const approvedAt = new Date().toISOString();

  for (const ruleFile of files) {
    const sha256 = sha256File(ruleFile);
    if (sha256 === null) return err(`could not read ${toRepoRelative(scope.repoRoot, ruleFile)}`);
    const file = toRepoRelative(scope.repoRoot, ruleFile);
    const mac = machineMac(macParts(scope.repoRoot, packName, file, sha256), /* create */ true);
    if (mac === null) {
      return err(
        "no machine key could be created — set KEEL_HOME to a writable directory outside the repository",
      );
    }
    approved.push({ pack: packName, file, sha256, approvedAt, mac });
  }

  const kept = readStore(scope.repoRoot).rules.filter(
    (r) => !approved.some((a) => a.pack === r.pack && a.file === r.file),
  );
  const written = writeStore(scope.repoRoot, { version: 1, rules: [...kept, ...approved] });
  if (!written.ok) return written;

  logDebug("pack rule trusted", { pack: packName, files: approved.length });
  return ok(approved);
}

/** Revoke every approval for one pack. Returns how many records were removed. */
export function untrustRule(repoRoot: string, packName: string): Result<number, string> {
  const store = readStore(repoRoot);
  const kept = store.rules.filter((r) => r.pack !== packName);
  const removed = store.rules.length - kept.length;
  if (removed === 0) return ok(0);
  const written = writeStore(repoRoot, { version: 1, rules: kept });
  if (!written.ok) return written;
  return ok(removed);
}

/** Drop the cached trust store and machine key. Test-only seam. */
export function resetTrustCache(): void {
  storeCache = null;
  keyCache = null;
}
