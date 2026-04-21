import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../../platform/types.js";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanBlocker,
  UltraPlanManifest,
  UltraPlanSessionMigrationRecord,
} from "../../types.js";
import {
  validateUltraPlanAuthoredArtifact,
  validateUltraPlanManifest,
  validateUltraPlanSessionMigrationRecord,
} from "../contracts.js";
import {
  getLegacyUltraplanSessionDir,
  getUltraplanAuthoredJsonPath,
  getUltraplanManifestPath,
  getUltraplanMigrationRecordPath,
  getUltraplanSessionDir,
  ULTRAPLAN_AUTHORED_JSON_FILENAME,
  ULTRAPLAN_MANIFEST_FILENAME,
} from "../project-paths.js";
import {
  buildMigrationConflictBlocker,
  buildMigrationUnsafeBlocker,
} from "./blockers.js";
import { saveMigrationRecord } from "./tracker-storage.js";

/**
 * Slice-2 migration engine.
 *
 * Implements the 7-branch decision procedure from the delta spec §per-session decision procedure.
 * The engine runs fail-closed: any branch it cannot complete deterministically surfaces a
 * structured `migration-unsafe` or `migration-conflict` blocker instead of a partially-migrated
 * global directory.
 */

export interface ResolveSessionMigrationInput {
  paths: PlatformPaths;
  cwd: string;
  sessionId: string;
  nowIso: string;
}

export type MigrationOutcome =
  | { kind: "skip" }
  | { kind: "native" }
  | { kind: "migrated-copied"; record: UltraPlanSessionMigrationRecord }
  | { kind: "reconciled-no-op"; record: UltraPlanSessionMigrationRecord }
  | { kind: "blocked"; blocker: UltraPlanBlocker };

interface GlobalState {
  exists: boolean;
  authored: UltraPlanAuthoredArtifact | null;
  manifest: UltraPlanManifest | null;
  hasMigrationJson: boolean;
  migrationJsonValid: boolean;
}

interface LegacyState {
  exists: boolean;
  authored: UltraPlanAuthoredArtifact | null;
  manifest: UltraPlanManifest | null;
  /** True when authored.json and manifest.json are both present and pass schema validation. */
  canonical: boolean;
  legacyDir: string;
}

export function resolveSessionMigration(input: ResolveSessionMigrationInput): MigrationOutcome {
  const global = inspectGlobal(input);
  const legacy = inspectLegacy(input);

  // Branch 1: no global, no legacy.
  if (!global.exists && !legacy.exists) {
    return { kind: "skip" };
  }

  // Branch 6: global absent, legacy present.
  if (!global.exists && legacy.exists) {
    return migrateFromLegacy(input, legacy);
  }

  // Global exists. Branch 3/4 only apply when the global directory is canonical per the delta
  // spec definition: authored+manifest valid AND (no legacy OR migration.json present+valid).
  // A global directory with matching content but no migration.json is partial/interrupted —
  // the spec explicitly forbids the loader from accepting it as canonical on retry.
  const globalHasValidArtifacts = global.authored !== null && global.manifest !== null;
  const globalIsCanonical = globalHasValidArtifacts
    && (!legacy.exists || (global.hasMigrationJson && global.migrationJsonValid));

  if (globalIsCanonical && legacy.exists && legacy.canonical) {
    const fingerprintGlobal = fingerprintArtifacts(global.authored!, global.manifest!);
    const fingerprintLegacy = fingerprintArtifacts(legacy.authored!, legacy.manifest!);
    const contentsMatch =
      fingerprintGlobal === fingerprintLegacy
      && global.manifest!.updatedAt === legacy.manifest!.updatedAt
      && sameCursor(global.manifest!.cursor, legacy.manifest!.cursor);
    if (contentsMatch) {
      return reconcileSameContent(input, legacy, fingerprintGlobal);
    }
    // Branch 4: both canonical-shaped but contents conflict.
    return {
      kind: "blocked",
      blocker: buildMigrationConflictBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        globalPath: getUltraplanSessionDir(input.paths, input.cwd, input.sessionId),
        reason: describeContentMismatch(global, legacy, fingerprintGlobal, fingerprintLegacy),
      }),
    };
  }

  // Branch 2: canonical global, no legacy.
  if (globalIsCanonical && !legacy.exists) {
    return { kind: "native" };
  }

  // Branch 5: non-canonical global with a valid legacy copy. Rename the partial global directory,
  // then migrate in from legacy via branch 6.
  if (legacy.exists && legacy.canonical) {
    return recoverFromPartialGlobal(input, legacy);
  }

  // Branch 7: non-canonical global, no legacy. Rename the partial global directory and emit a
  // migration-unsafe blocker naming the interrupted path.
  return classifyOrphanedGlobal(input);
}

// ---------------------------------------------------------------------------
// Branch 6 — copy legacy into global, then rename legacy
// ---------------------------------------------------------------------------

function migrateFromLegacy(input: ResolveSessionMigrationInput, legacy: LegacyState): MigrationOutcome {
  if (!legacy.canonical || !legacy.authored || !legacy.manifest) {
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: "legacy authored.json or manifest.json failed schema validation",
      }),
    };
  }

  const globalDir = getUltraplanSessionDir(input.paths, input.cwd, input.sessionId);

  // Durability order: copy tree, then write migration.json, then rename legacy.
  try {
    fs.mkdirSync(globalDir, { recursive: true });
    copyDirectoryTree(legacy.legacyDir, globalDir);
  } catch (error) {
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: `copy failed before migration.json could be written: ${formatError(error)}`,
      }),
    };
  }

  const fingerprintBefore = fingerprintLegacyArtifacts(legacy.authored, legacy.manifest);
  const fingerprintAfter = fingerprintGlobalArtifacts(input);
  if (fingerprintBefore !== fingerprintAfter) {
    // Copy corrupted the canonical content; back out.
    safeRemove(globalDir);
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: "copy produced non-matching fingerprint; aborted",
      }),
    };
  }

  const renamedPath = interruptedOrMigratedPath(legacy.legacyDir, "migrated", input.nowIso);

  const record: UltraPlanSessionMigrationRecord = {
    migratedAt: input.nowIso,
    legacyPath: legacy.legacyDir,
    fingerprintBefore,
    fingerprintAfter,
    legacyRenamedTo: renamedPath,
    kind: "copied",
  };

  const saved = saveMigrationRecord(input.paths, input.cwd, input.sessionId, record);
  if (!saved.ok) {
    safeRemove(globalDir);
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: `migration.json write failed: ${saved.error.message}`,
      }),
    };
  }

  try {
    fs.renameSync(legacy.legacyDir, renamedPath);
  } catch (error) {
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: `legacy rename failed: ${formatError(error)}`,
      }),
    };
  }

  return { kind: "migrated-copied", record };
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

function inspectGlobal(input: ResolveSessionMigrationInput): GlobalState {
  const globalDir = getUltraplanSessionDir(input.paths, input.cwd, input.sessionId);
  if (!fs.existsSync(globalDir)) {
    return { exists: false, authored: null, manifest: null, hasMigrationJson: false, migrationJsonValid: false };
  }
  const authored = readValidatedAuthored(getUltraplanAuthoredJsonPath(input.paths, input.cwd, input.sessionId));
  const manifest = readValidatedManifest(getUltraplanManifestPath(input.paths, input.cwd, input.sessionId));
  const migrationPath = getUltraplanMigrationRecordPath(input.paths, input.cwd, input.sessionId);
  const hasMigrationJson = fs.existsSync(migrationPath);
  let migrationJsonValid = false;
  if (hasMigrationJson) {
    try {
      const raw = JSON.parse(fs.readFileSync(migrationPath, "utf8"));
      migrationJsonValid = validateUltraPlanSessionMigrationRecord(raw).ok;
    } catch {
      migrationJsonValid = false;
    }
  }
  return {
    exists: true,
    authored,
    manifest,
    hasMigrationJson,
    migrationJsonValid,
  };
}

function inspectLegacy(input: ResolveSessionMigrationInput): LegacyState {
  const legacyDir = getLegacyUltraplanSessionDir(input.cwd, input.sessionId);
  if (!fs.existsSync(legacyDir)) {
    return { exists: false, authored: null, manifest: null, canonical: false, legacyDir };
  }
  const authored = readValidatedAuthored(path.join(legacyDir, ULTRAPLAN_AUTHORED_JSON_FILENAME));
  const manifest = readValidatedManifest(path.join(legacyDir, ULTRAPLAN_MANIFEST_FILENAME));
  const canonical = authored !== null && manifest !== null;
  return { exists: true, authored, manifest, canonical, legacyDir };
}

function isGlobalCanonical(global: GlobalState, legacy: LegacyState): boolean {
  if (!global.exists) return false;
  if (!global.authored || !global.manifest) return false;
  // Either no legacy copy (native), or migration.json present and valid (migrated).
  if (!legacy.exists) return true;
  return global.hasMigrationJson && global.migrationJsonValid;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readValidatedAuthored(filePath: string): UltraPlanAuthoredArtifact | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const result = validateUltraPlanAuthoredArtifact(raw);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

function readValidatedManifest(filePath: string): UltraPlanManifest | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const result = validateUltraPlanManifest(raw);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

function copyDirectoryTree(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyDirectoryTree(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function safeRemove(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // best effort cleanup; the caller is already in a blocked state
  }
}

function interruptedOrMigratedPath(source: string, suffix: "migrated" | "interrupted", nowIso: string): string {
  const safeTimestamp = nowIso.replace(/[:.]/g, "-");
  return `${source}.${suffix}-${safeTimestamp}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function fingerprintLegacyArtifacts(authored: UltraPlanAuthoredArtifact, manifest: UltraPlanManifest): string {
  return fingerprintArtifacts(authored, manifest);
}

function fingerprintGlobalArtifacts(input: ResolveSessionMigrationInput): string {
  const authored = readValidatedAuthored(getUltraplanAuthoredJsonPath(input.paths, input.cwd, input.sessionId));
  const manifest = readValidatedManifest(getUltraplanManifestPath(input.paths, input.cwd, input.sessionId));
  if (!authored || !manifest) {
    // Produce a distinct, non-canonical sentinel so the caller can detect the mismatch.
    return `sha256:incomplete-global-${Date.now()}`;
  }
  return fingerprintArtifacts(authored, manifest);
}

function fingerprintArtifacts(authored: UltraPlanAuthoredArtifact, manifest: UltraPlanManifest): string {
  const canonical = JSON.stringify({
    authored: canonicalize(authored),
    manifest: canonicalize(manifest),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}


function reconcileSameContent(
  input: ResolveSessionMigrationInput,
  legacy: LegacyState,
  fingerprint: string,
): MigrationOutcome {
  const migrationPath = getUltraplanMigrationRecordPath(input.paths, input.cwd, input.sessionId);
  const renamedPath = interruptedOrMigratedPath(legacy.legacyDir, "migrated", input.nowIso);

  const record: UltraPlanSessionMigrationRecord = {
    migratedAt: input.nowIso,
    legacyPath: legacy.legacyDir,
    fingerprintBefore: fingerprint,
    fingerprintAfter: fingerprint,
    legacyRenamedTo: renamedPath,
    kind: "reconciled-no-op",
  };

  // Branch 3 semantics: ensure migration.json exists. If it already does, leave it as-is (it was
  // written by a prior migration). Otherwise write a fresh reconciled-no-op record.
  let persistedRecord: UltraPlanSessionMigrationRecord = record;
  if (fs.existsSync(migrationPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(migrationPath, "utf8"));
      const validation = validateUltraPlanSessionMigrationRecord(raw);
      if (validation.ok) {
        persistedRecord = validation.value;
      }
    } catch {
      // Fall through and write a fresh record below.
    }
    // If the existing file is invalid JSON or schema-invalid, overwrite with a fresh record.
    if (persistedRecord === record) {
      const saved = saveMigrationRecord(input.paths, input.cwd, input.sessionId, record);
      if (!saved.ok) {
        return {
          kind: "blocked",
          blocker: buildMigrationUnsafeBlocker({
            detectedAt: input.nowIso,
            legacyPath: legacy.legacyDir,
            reason: `reconciled migration.json write failed: ${saved.error.message}`,
          }),
        };
      }
    }
  } else {
    const saved = saveMigrationRecord(input.paths, input.cwd, input.sessionId, record);
    if (!saved.ok) {
      return {
        kind: "blocked",
        blocker: buildMigrationUnsafeBlocker({
          detectedAt: input.nowIso,
          legacyPath: legacy.legacyDir,
          reason: `reconciled migration.json write failed: ${saved.error.message}`,
        }),
      };
    }
  }

  try {
    fs.renameSync(legacy.legacyDir, renamedPath);
  } catch (error) {
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: `legacy rename failed during reconciliation: ${formatError(error)}`,
      }),
    };
  }

  return { kind: "reconciled-no-op", record: persistedRecord };
}

function sameCursor(a: UltraPlanManifest["cursor"], b: UltraPlanManifest["cursor"]): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.targetType === b.targetType
    && a.stack === b.stack
    && a.domainId === b.domainId
    && a.level === b.level
    && a.scenarioId === b.scenarioId
    && a.phase === b.phase
    && a.status === b.status;
}

// ---------------------------------------------------------------------------
// Branch 5 — partial global, valid legacy: rename partial global then migrate from legacy.
// ---------------------------------------------------------------------------

function recoverFromPartialGlobal(
  input: ResolveSessionMigrationInput,
  legacy: LegacyState,
): MigrationOutcome {
  const globalDir = getUltraplanSessionDir(input.paths, input.cwd, input.sessionId);
  const interruptedPath = interruptedOrMigratedPath(globalDir, "interrupted", input.nowIso);
  try {
    fs.renameSync(globalDir, interruptedPath);
  } catch (error) {
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: legacy.legacyDir,
        reason: `failed to rename partial global directory: ${formatError(error)}`,
        interruptedPath,
      }),
    };
  }
  // Re-run branch 6 against the now-absent global directory.
  return migrateFromLegacy(input, legacy);
}

// ---------------------------------------------------------------------------
// Branch 7 — non-canonical global, no legacy: rename and emit migration-unsafe blocker.
// ---------------------------------------------------------------------------

function classifyOrphanedGlobal(input: ResolveSessionMigrationInput): MigrationOutcome {
  const globalDir = getUltraplanSessionDir(input.paths, input.cwd, input.sessionId);
  const interruptedPath = interruptedOrMigratedPath(globalDir, "interrupted", input.nowIso);
  try {
    fs.renameSync(globalDir, interruptedPath);
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: getLegacyUltraplanSessionDir(input.cwd, input.sessionId),
        reason: "global session directory is not canonical and no legacy copy is available",
        interruptedPath,
      }),
    };
  } catch (error) {
    return {
      kind: "blocked",
      blocker: buildMigrationUnsafeBlocker({
        detectedAt: input.nowIso,
        legacyPath: getLegacyUltraplanSessionDir(input.cwd, input.sessionId),
        reason: `failed to rename non-canonical global directory: ${formatError(error)}`,
      }),
    };
  }
}

function describeContentMismatch(
  global: GlobalState,
  legacy: LegacyState,
  fingerprintGlobal: string,
  fingerprintLegacy: string,
): string {
  const reasons: string[] = [];
  if (global.manifest?.updatedAt !== legacy.manifest?.updatedAt) {
    reasons.push(`updatedAt differs (global=${global.manifest?.updatedAt}, legacy=${legacy.manifest?.updatedAt})`);
  }
  if (!sameCursor(global.manifest?.cursor ?? null, legacy.manifest?.cursor ?? null)) {
    reasons.push("cursor differs");
  }
  if (fingerprintGlobal !== fingerprintLegacy) {
    reasons.push("authored/manifest fingerprints differ");
  }
  return reasons.length > 0 ? reasons.join("; ") : "contents differ";
}