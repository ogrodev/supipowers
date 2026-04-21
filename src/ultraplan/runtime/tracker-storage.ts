import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanHookObservation,
  UltraPlanPendingMutation,
  UltraPlanRuntimeTracker,
  UltraPlanSessionMigrationRecord,
  UltraPlanStorageError,
  UltraPlanStorageResult,
} from "../../types.js";
import {
  validateUltraPlanRuntimeTracker,
  validateUltraPlanSessionMigrationRecord,
} from "../contracts.js";
import {
  getUltraplanHooksLogPath,
  getUltraplanMigrationRecordPath,
  getUltraplanRuntimeTrackerPath,
} from "../project-paths.js";

/**
 * Slice-2 runtime storage seam.
 *
 * This module owns the durable read/write path for `runtime-tracker.json` and `migration.json`.
 * Task 2.3 will grow this module to additionally own `hooks-log.jsonl`, pendingMutation staging,
 * and reconciliation of partial writes against the manifest. For Slice 2/1.4 it provides the
 * round-trip primitives that the storage wrappers and the migration engine depend on.
 */

function success<T>(value: T): UltraPlanStorageResult<T> {
  return { ok: true, value };
}

function failure(
  pathname: string,
  kind: UltraPlanStorageError["kind"],
  message: string,
  details?: string[],
): UltraPlanStorageResult<never> {
  return {
    ok: false,
    error: {
      kind,
      path: pathname,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath: string): UltraPlanStorageResult<unknown> {
  if (!fs.existsSync(filePath)) {
    return failure(filePath, "missing", `Artifact not found: ${filePath}`);
  }
  try {
    return success(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    return failure(
      filePath,
      "invalid-json",
      error instanceof Error ? error.message : `Invalid JSON in ${filePath}`,
    );
  }
}

/**
 * Atomic write: write to a sibling `*.tmp` file, then rename onto the destination. Prevents a
 * half-written tracker from surviving a crash and being observed by the loader.
 */
function writeJsonAtomic(filePath: string, payload: unknown): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmpPath, filePath);
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to write ${filePath}`,
    );
  }
}

/**
 * Load the runtime tracker for a given session. Missing tracker is a first-class, non-error
 * state — callers treat it as "no prior runtime state."
 */
export function loadTracker(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanRuntimeTracker> {
  const filePath = getUltraplanRuntimeTrackerPath(paths, cwd, sessionId);
  const parsed = readJsonFile(filePath);
  if (!parsed.ok) return parsed;

  const validation = validateUltraPlanRuntimeTracker(parsed.value);
  if (!validation.ok) {
    return failure(
      filePath,
      "validation-error",
      `Runtime tracker failed schema validation: ${filePath}`,
      validation.errors,
    );
  }
  return success(validation.value);
}

/**
 * Save the runtime tracker atomically after semantic and schema validation. Writes never observe
 * a half-finalized tracker because the destination rename happens in one filesystem step.
 */
export function saveTrackerAtomic(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  tracker: UltraPlanRuntimeTracker,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanRuntimeTrackerPath(paths, cwd, sessionId);
  // Normalize the applied-fingerprint ledger before validation: the invariant enforced on
  // disk is that it contains no duplicates. Callers may hand in repeated fingerprints from
  // replay flows; we dedupe once here so the persisted tracker stays coherent.
  const normalized: UltraPlanRuntimeTracker = {
    ...tracker,
    appliedFingerprints: dedupeInOrder(tracker.appliedFingerprints),
  };
  const validation = validateUltraPlanRuntimeTracker(normalized);
  if (!validation.ok) {
    return failure(
      filePath,
      "validation-error",
      `Runtime tracker failed schema validation: ${filePath}`,
      validation.errors,
    );
  }
  return writeJsonAtomic(filePath, validation.value);
}

function dedupeInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function loadMigrationRecord(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<UltraPlanSessionMigrationRecord> {
  const filePath = getUltraplanMigrationRecordPath(paths, cwd, sessionId);
  const parsed = readJsonFile(filePath);
  if (!parsed.ok) return parsed;

  const validation = validateUltraPlanSessionMigrationRecord(parsed.value);
  if (!validation.ok) {
    return failure(
      filePath,
      "validation-error",
      `Migration record failed schema validation: ${filePath}`,
      validation.errors,
    );
  }
  return success(validation.value);
}

export function saveMigrationRecord(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  record: UltraPlanSessionMigrationRecord,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanMigrationRecordPath(paths, cwd, sessionId);
  const validation = validateUltraPlanSessionMigrationRecord(record);
  if (!validation.ok) {
    return failure(
      filePath,
      "validation-error",
      `Migration record failed schema validation: ${filePath}`,
      validation.errors,
    );
  }
  return writeJsonAtomic(filePath, validation.value);
}


// ---------------------------------------------------------------------------
// Hooks log (append-only JSONL)
// ---------------------------------------------------------------------------

/**
 * Append a normalized hook observation to `hooks-log.jsonl`. This is the audit trail the
 * reducer reads on replay. The append is suppressed for observations whose `fingerprint` has
 * already been persisted into the tracker's `appliedFingerprints` set — that is what makes
 * replay a persisted no-op on both the tracker AND the hooks log.
 */
export function appendHookLog(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  observation: UltraPlanHookObservation,
): UltraPlanStorageResult<string> {
  const trackerResult = loadTracker(paths, cwd, sessionId);
  if (trackerResult.ok) {
    if (trackerResult.value.appliedFingerprints.includes(observation.fingerprint)) {
      // Observation already applied; replay is a persisted no-op.
      return success(getUltraplanHooksLogPath(paths, cwd, sessionId));
    }
  } else if (trackerResult.error.kind !== "missing") {
    // Tracker exists but is unreadable; fail closed.
    return trackerResult;
  }

  const logPath = getUltraplanHooksLogPath(paths, cwd, sessionId);
  try {
    ensureDir(logPath);
    fs.appendFileSync(logPath, `${JSON.stringify(observation)}\n`);
    return success(logPath);
  } catch (error) {
    return failure(
      logPath,
      "io",
      error instanceof Error ? error.message : `Unable to append ${logPath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pending-mutation staging and reconciliation
// ---------------------------------------------------------------------------

/**
 * Stage a pending mutation atomically: load the tracker, set `pendingMutation`, and rewrite.
 * Caller provides the exact `UltraPlanPendingMutation` record (attemptId, plan, expected
 * manifest fingerprint, stagedAt) per spec §durability order item 3.
 */
export function stagePendingMutation(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  pending: UltraPlanPendingMutation,
): UltraPlanStorageResult<string> {
  const loaded = loadTracker(paths, cwd, sessionId);
  if (!loaded.ok) return loaded;
  const next: UltraPlanRuntimeTracker = {
    ...loaded.value,
    pendingMutation: pending,
    updatedAt: pending.stagedAt,
  };
  return saveTrackerAtomic(paths, cwd, sessionId, next);
}

/**
 * Clear `pendingMutation` atomically. Used at the end of the durability order (item 5) when
 * the manifest write has already landed and the attempt is committed to the finalized ledger.
 */
export function clearPendingMutation(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
): UltraPlanStorageResult<string> {
  const loaded = loadTracker(paths, cwd, sessionId);
  if (!loaded.ok) return loaded;
  if (loaded.value.pendingMutation === null) {
    return success(getUltraplanRuntimeTrackerPath(paths, cwd, sessionId));
  }
  const next: UltraPlanRuntimeTracker = {
    ...loaded.value,
    pendingMutation: null,
  };
  return saveTrackerAtomic(paths, cwd, sessionId, next);
}

export type UltraPlanReconciliationOutcome =
  | { kind: "no-pending" }
  | { kind: "committed" }
  | { kind: "replay-needed"; pending: UltraPlanPendingMutation };

/**
 * Reconcile a staged `pendingMutation` against the actual manifest contents on resume.
 *
 * - When no pending mutation is present, returns `no-pending`.
 * - When the manifest already matches the staged `expectedManifestFingerprint`, the pending
 *   mutation is considered committed: clear it and return `committed`.
 * - Otherwise return `replay-needed` and leave the pending mutation in place so the caller can
 *   replay the mutation plan idempotently.
 */
export function reconcilePendingMutationAgainstManifest(
  paths: PlatformPaths,
  cwd: string,
  sessionId: string,
  actualManifestFingerprint: string,
): UltraPlanStorageResult<UltraPlanReconciliationOutcome> {
  const loaded = loadTracker(paths, cwd, sessionId);
  if (!loaded.ok) return loaded;
  const pending = loaded.value.pendingMutation;
  if (pending === null) {
    return success({ kind: "no-pending" });
  }
  if (pending.expectedManifestFingerprint === actualManifestFingerprint) {
    const cleared = clearPendingMutation(paths, cwd, sessionId);
    if (!cleared.ok) return cleared;
    return success({ kind: "committed" });
  }
  return success({ kind: "replay-needed", pending });
}