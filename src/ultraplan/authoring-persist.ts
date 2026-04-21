import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type {
  UltraPlanAuthoredArtifact,
  UltraPlanIndex,
  UltraPlanIndexEntry,
  UltraPlanManifest,
  UltraPlanStorageError,
} from "../types.js";
import {
  getUltraplanAuthoredJsonPath,
  getUltraplanIndexPath,
  getUltraplanManifestPath,
  getUltraplanSessionDir,
} from "./project-paths.js";
import {
  loadUltraPlanIndex,
  loadUltraPlanManifest,
  saveUltraPlanAuthoredArtifact,
  saveUltraPlanIndex,
  saveUltraPlanManifest,
} from "./storage.js";

export interface AuthoringPersistInput {
  paths: PlatformPaths;
  cwd: string;
  authored: UltraPlanAuthoredArtifact;
  manifest: UltraPlanManifest;
}

export type AuthoringPersistError =
  | { kind: "session-id-exists" }
  | { kind: "index-invalid"; error: UltraPlanStorageError }
  | { kind: "storage-error"; error: UltraPlanStorageError; written: string[] };

export type AuthoringPersistResult =
  | {
    ok: true;
    authoredPath: string;
    manifestPath: string;
    indexPath: string;
    reclaimed: boolean;
  }
  | { ok: false; error: AuthoringPersistError };

function buildIndexEntryFromManifest(manifest: UltraPlanManifest): UltraPlanIndexEntry {
  return {
    sessionId: manifest.sessionId,
    title: manifest.title,
    state: manifest.state,
    bucket: "pending",
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    cursor: manifest.cursor,
    idleReason: null,
  };
}

function upsertIndexEntry(index: UltraPlanIndex, entry: UltraPlanIndexEntry): UltraPlanIndex {
  const sessions = index.sessions.filter((s) => s.sessionId !== entry.sessionId);
  sessions.push(entry);
  return { sessions };
}

function reclaimDebris(sessionDir: string): void {
  if (!fs.existsSync(sessionDir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      fs.unlinkSync(path.join(sessionDir, entry.name));
    } catch {
      // best-effort
    }
  }
}

function bestEffortRmdir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // best-effort
  }
}

function loadIndexOrBootstrap(
  paths: PlatformPaths,
  cwd: string,
): { ok: true; index: UltraPlanIndex } | { ok: false; error: UltraPlanStorageError } {
  const loaded = loadUltraPlanIndex(paths, cwd);
  if (loaded.ok) {
    return { ok: true, index: loaded.value };
  }
  if (loaded.error.kind === "missing") {
    return { ok: true, index: { sessions: [] } };
  }
  return { ok: false, error: loaded.error };
}

export function persistAuthoredUltraPlanSession(input: AuthoringPersistInput): AuthoringPersistResult {
  const { paths, cwd, authored, manifest } = input;

  // Step 1: load and validate the existing index before touching the filesystem.
  const indexLoad = loadIndexOrBootstrap(paths, cwd);
  if (!indexLoad.ok) {
    return { ok: false, error: { kind: "index-invalid", error: indexLoad.error } };
  }
  let index = indexLoad.index;

  // Step 2: resolve debris / collision branch.
  const existingEntry = index.sessions.find((s) => s.sessionId === authored.sessionId);
  let reclaimed = false;
  if (existingEntry) {
    const existingManifest = loadUltraPlanManifest(paths, cwd, authored.sessionId);
    if (existingManifest.ok) {
      return { ok: false, error: { kind: "session-id-exists" } };
    }
    // Stale debris: manifest missing or invalid. Reclaim the directory.
    reclaimDebris(getUltraplanSessionDir(paths, cwd, authored.sessionId));
    index = { sessions: index.sessions.filter((s) => s.sessionId !== authored.sessionId) };
    reclaimed = true;
  }

  // Step 3: atomic write in order authored → manifest → index.
  const authoredPath = getUltraplanAuthoredJsonPath(paths, cwd, authored.sessionId);
  const manifestPath = getUltraplanManifestPath(paths, cwd, authored.sessionId);
  const indexPath = getUltraplanIndexPath(paths, cwd);
  const sessionDir = getUltraplanSessionDir(paths, cwd, authored.sessionId);
  const written: string[] = [];

  const authoredSave = saveUltraPlanAuthoredArtifact(paths, cwd, authored.sessionId, authored);
  if (!authoredSave.ok) {
    bestEffortRmdir(sessionDir);
    return { ok: false, error: { kind: "storage-error", error: authoredSave.error, written: [] } };
  }
  written.push(authoredSave.value);

  const manifestSave = saveUltraPlanManifest(paths, cwd, authored.sessionId, manifest);
  if (!manifestSave.ok) {
    for (const file of [...written].reverse()) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best-effort
      }
    }
    bestEffortRmdir(sessionDir);
    return { ok: false, error: { kind: "storage-error", error: manifestSave.error, written: [...written] } };
  }
  written.push(manifestSave.value);

  const indexEntry = buildIndexEntryFromManifest(manifest);
  const nextIndex = upsertIndexEntry(index, indexEntry);
  const indexSave = saveUltraPlanIndex(paths, cwd, nextIndex);
  if (!indexSave.ok) {
    for (const file of [...written].reverse()) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best-effort
      }
    }
    bestEffortRmdir(sessionDir);
    return { ok: false, error: { kind: "storage-error", error: indexSave.error, written: [...written] } };
  }

  return {
    ok: true,
    authoredPath,
    manifestPath,
    indexPath,
    reclaimed,
  };
}
