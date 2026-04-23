import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanBatchActiveRunLease,
  UltraPlanBatchJournalEvent,
  UltraPlanBatchRun,
  UltraPlanStorageError,
  UltraPlanStorageResult,
} from "../../types.js";
import {
  getUltraPlanSchemaErrors,
  UltraPlanBatchJournalEventSchema,
  validateUltraPlanBatchActiveRunLease,
  validateUltraPlanBatchRun,
} from "../contracts.js";
import {
  getUltraplanActiveBatchRunPath,
  getUltraplanBatchJournalPath,
  getUltraplanBatchRunPath,
} from "../project-paths.js";

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

function writeJsonFile(filePath: string, payload: unknown): UltraPlanStorageResult<string> {
  try {
    ensureDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to write ${filePath}`,
    );
  }
}


function validateBatchRunForStorage(
  filePath: string,
  value: unknown,
): UltraPlanStorageResult<UltraPlanBatchRun> {
  const validation = validateUltraPlanBatchRun(value);
  if (!validation.ok) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, validation.errors);
  }


  return success(validation.value);
}

function validateBatchLeaseForStorage(
  filePath: string,
  value: unknown,
 ): UltraPlanStorageResult<UltraPlanBatchActiveRunLease> {
  const validation = validateUltraPlanBatchActiveRunLease(value);
  if (!validation.ok) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, validation.errors);
  }


  return success(validation.value);
}

function parseLeaseTimestamp(
  filePath: string,
  fieldName: string,
  value: string | null,
 ): UltraPlanStorageResult<number | null> {
  if (value === null) {
    return success(null);
  }

  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      `${fieldName} must be a valid ISO timestamp`,
    ]);
  }

  return success(millis);
}


export function loadUltraPlanBatchRun(
  paths: PlatformPaths,
  cwd: string,
  runId: string,
): UltraPlanStorageResult<UltraPlanBatchRun> {
  const filePath = getUltraplanBatchRunPath(paths, cwd, runId);
  const parsed = readJsonFile(filePath);
  if (!parsed.ok) {
    return parsed;
  }

  return validateBatchRunForStorage(filePath, parsed.value);
}

export function saveUltraPlanBatchRun(
  paths: PlatformPaths,
  cwd: string,
  run: UltraPlanBatchRun,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanBatchRunPath(paths, cwd, run.runId);
  const validation = validateBatchRunForStorage(filePath, run);
  if (!validation.ok) {
    return validation;
  }

  return writeJsonFile(filePath, validation.value);
}

export function loadUltraPlanBatchJournal(
  paths: PlatformPaths,
  cwd: string,
  runId: string,
): UltraPlanStorageResult<UltraPlanBatchJournalEvent[]> {
  const filePath = getUltraplanBatchJournalPath(paths, cwd, runId);
  if (!fs.existsSync(filePath)) {
    return success([]);
  }

  try {
    const entries: UltraPlanBatchJournalEvent[] = [];
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        return failure(
          filePath,
          "invalid-json",
          error instanceof Error ? error.message : `Invalid JSON in ${filePath}`,
          [`journal line ${index + 1} is not valid JSON`],
        );
      }

      const errors = getUltraPlanSchemaErrors(UltraPlanBatchJournalEventSchema, parsed);
      if (errors.length > 0) {
        return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, errors);
      }
      entries.push(parsed as UltraPlanBatchJournalEvent);
    }

    return success(entries);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to read ${filePath}`,
    );
  }
}

export function appendUltraPlanBatchJournalEvent(
  paths: PlatformPaths,
  cwd: string,
  runId: string,
  event: UltraPlanBatchJournalEvent,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanBatchJournalPath(paths, cwd, runId);
  const errors = getUltraPlanSchemaErrors(UltraPlanBatchJournalEventSchema, event);
  if (errors.length > 0) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, errors);
  }

  try {
    ensureDir(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to append ${filePath}`,
    );
  }
}

export function loadUltraPlanBatchActiveRunLease(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<UltraPlanBatchActiveRunLease | null> {
  const filePath = getUltraplanActiveBatchRunPath(paths, cwd);
  if (!fs.existsSync(filePath)) {
    return success(null);
  }

  const parsed = readJsonFile(filePath);
  if (!parsed.ok) {
    return parsed;
  }

  return validateBatchLeaseForStorage(filePath, parsed.value);
}

export function saveUltraPlanBatchActiveRunLease(
  paths: PlatformPaths,
  cwd: string,
  lease: UltraPlanBatchActiveRunLease,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanActiveBatchRunPath(paths, cwd);
  const validation = validateBatchLeaseForStorage(filePath, lease);
  if (!validation.ok) {
    return validation;
  }

  return writeJsonFile(filePath, validation.value);
}

export function clearUltraPlanBatchActiveRunLease(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanActiveBatchRunPath(paths, cwd);
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath);
    }
    return success(filePath);
  } catch (error) {
    return failure(
      filePath,
      "io",
      error instanceof Error ? error.message : `Unable to remove ${filePath}`,
    );
  }
}

export function loadUltraPlanActiveBatchRun(
  paths: PlatformPaths,
  cwd: string,
): UltraPlanStorageResult<UltraPlanBatchRun | null> {
  const lease = loadUltraPlanBatchActiveRunLease(paths, cwd);
  if (!lease.ok) {
    return lease;
  }
  if (lease.value === null) {
    return success(null);
  }

  return loadUltraPlanBatchRun(paths, cwd, lease.value.runId);
}

export function acquireUltraPlanBatchActiveRunLease(
  paths: PlatformPaths,
  cwd: string,
  lease: UltraPlanBatchActiveRunLease,
  options?: { nowIso?: string },
): UltraPlanStorageResult<UltraPlanBatchActiveRunLease> {
  const filePath = getUltraplanActiveBatchRunPath(paths, cwd);
  const validation = validateBatchLeaseForStorage(filePath, lease);
  if (!validation.ok) {
    return validation;
  }
  if (
    validation.value.ownerSessionId === null
    || validation.value.leaseAcquiredAt === null
    || validation.value.leaseExpiresAt === null
  ) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      "acquired lease must include ownerSessionId, leaseAcquiredAt, and leaseExpiresAt",
    ]);
  }

  const trustedNow = parseLeaseTimestamp(filePath, "nowIso", options?.nowIso ?? new Date().toISOString());
  if (!trustedNow.ok) {
    return trustedNow;
  }
  const requestedAcquiredAt = parseLeaseTimestamp(filePath, "leaseAcquiredAt", validation.value.leaseAcquiredAt);
  if (!requestedAcquiredAt.ok) {
    return requestedAcquiredAt;
  }
  const requestedExpiresAt = parseLeaseTimestamp(filePath, "leaseExpiresAt", validation.value.leaseExpiresAt);
  if (!requestedExpiresAt.ok) {
    return requestedExpiresAt;
  }
  if ((requestedAcquiredAt.value ?? 0) > (trustedNow.value ?? 0)) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      "leaseAcquiredAt cannot be in the future relative to nowIso",
    ]);
  }
  if ((requestedExpiresAt.value ?? 0) <= (trustedNow.value ?? 0)) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      "leaseExpiresAt must be in the future relative to nowIso",
    ]);
  }

  const current = loadUltraPlanBatchActiveRunLease(paths, cwd);
  if (!current.ok) {
    return current;
  }

  const currentLease = current.value;
  if (currentLease !== null) {
    const currentIsHeld = currentLease.ownerSessionId !== null
      && currentLease.leaseAcquiredAt !== null
      && currentLease.leaseExpiresAt !== null;
    const sameOwner = currentLease.runId === validation.value.runId
      && currentLease.ownerSessionId === validation.value.ownerSessionId;
    if (currentIsHeld && !sameOwner) {
      const existingExpiry = parseLeaseTimestamp(filePath, "leaseExpiresAt", currentLease.leaseExpiresAt);
      if (!existingExpiry.ok) {
        return existingExpiry;
      }
      if ((existingExpiry.value ?? 0) > (trustedNow.value ?? 0)) {
        return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
          `active-run lease already held by ${currentLease.ownerSessionId}`,
        ]);
      }
    }
  }

  const saved = saveUltraPlanBatchActiveRunLease(paths, cwd, validation.value);
  if (!saved.ok) {
    return saved;
  }
  return success(validation.value);
}

export function releaseUltraPlanBatchActiveRunLease(
  paths: PlatformPaths,
  cwd: string,
  leaseOwner: Pick<UltraPlanBatchActiveRunLease, "runId" | "ownerSessionId">,
  nextState: UltraPlanBatchRun["state"],
  releasedAt: string,
): UltraPlanStorageResult<string> {
  const filePath = getUltraplanActiveBatchRunPath(paths, cwd);
  if (!leaseOwner.ownerSessionId) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      "release requires the persisted ownerSessionId",
    ]);
  }

  const current = loadUltraPlanBatchActiveRunLease(paths, cwd);
  if (!current.ok) {
    return current;
  }
  if (current.value === null) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      "active-run lease is missing",
    ]);
  }
  if (current.value.runId !== leaseOwner.runId) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      `active-run lease points at ${current.value.runId}, not ${leaseOwner.runId}`,
    ]);
  }
  if (current.value.ownerSessionId !== leaseOwner.ownerSessionId) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      `active-run lease is owned by ${current.value.ownerSessionId}, not ${leaseOwner.ownerSessionId}`,
    ]);
  }
  if (current.value.leaseAcquiredAt === null || current.value.leaseExpiresAt === null) {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      "active-run lease is not currently held",
    ]);
  }

  if (nextState === "complete" || nextState === "abandoned") {
    return clearUltraPlanBatchActiveRunLease(paths, cwd);
  }

  if (nextState !== "paused" && nextState !== "blocked") {
    return failure(filePath, "validation-error", `Artifact failed schema validation: ${filePath}`, [
      `cannot release active-run lease for state ${nextState}`,
    ]);
  }

  const releasedLease: UltraPlanBatchActiveRunLease = {
    runId: leaseOwner.runId,
    ownerSessionId: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    updatedAt: releasedAt,
  };
  return saveUltraPlanBatchActiveRunLease(paths, cwd, releasedLease);
}
