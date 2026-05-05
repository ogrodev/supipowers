// src/context-mode/cache-store.ts
//
// Durable L3 cache metadata and payload store. Metadata lives in cache.db;
// compressed payload bytes live under cache-payloads/ so large blobs stay out
// of SQLite hot paths.

import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { parseCacheHandle, renderCacheHandle } from "./cache-handle.js";
import { buildCachePreview } from "./cache-preview.js";
import type { MetricRow } from "./metrics-store.js";

export const SCHEMA_VERSION = 1;
type CacheMetricRecorder = Pick<{ record(row: MetricRow): void }, "record">;

export interface CacheStoreOptions {
  dbPath: string;
  payloadRoot: string;
  projectSlug: string;
  metricsStore?: CacheMetricRecorder | null;
  metricsSessionId?: string;
}

export interface CacheStats {
  entryCount: number;
  refCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  payloadBytes: number;
}

export interface CacheClearResult {
  deletedRefs: number;
  deletedEntries: number;
  deletedPayloadBytes: number;
  retainedPayloadBytes: number;
}

export interface CacheSessionStats extends CacheStats {
  reclaimablePayloadBytes: number;
  retainedPayloadBytes: number;
}


export interface PutCacheTextInput {
  sessionId: string;
  text: string;
  sourceTool?: string | null;
  sourceHash?: string | null;
  now?: number;
  previewBytes?: number;
  recordMetric?: boolean;
}

export interface CacheEntryMeta {
  handle: string;
  sha256: string;
  sizeBytes: number;
  compressedBytes: number;
  preview: string;
  payloadRelpath: string;
  createdAt: number;
  lastAccessedAt: number;
  openCount: number;
}

export interface PutCacheTextResult extends CacheEntryMeta {}

export type OpenCacheTextResult =
  | { ok: true; handle: string; text: string; meta: CacheEntryMeta }
  | { ok: false; reason: "invalid_handle" | "not_found" | "missing_payload" | "corrupt_payload"; handle: string | null; message: string };

export interface RequestCachePutInput {
  tool: string;
  argsHash: string;
  cwd: string;
  fingerprint: string;
  handle: string;
  ttlMs: number;
  now?: number;
}

export interface RequestCacheLookupInput {
  tool: string;
  argsHash: string;
  cwd: string;
  fingerprint: string;
  now?: number;
}

export type RequestCacheLookupResult =
  | { hit: true; handle: string; expiresAt: number }
  | { hit: false; reason: "miss" | "expired" };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_entries (
  handle TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  preview TEXT NOT NULL,
  payload_relpath TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cache_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL REFERENCES cache_entries(handle) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  source_tool TEXT,
  source_hash TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(handle, session_id, source_tool, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_cache_refs_session ON cache_refs(session_id);
CREATE INDEX IF NOT EXISTS idx_cache_refs_handle ON cache_refs(handle);
CREATE INDEX IF NOT EXISTS idx_cache_entries_last_accessed ON cache_entries(last_accessed_at);

CREATE TABLE IF NOT EXISTS request_cache (
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  cwd TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  handle TEXT NOT NULL REFERENCES cache_entries(handle) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tool, args_hash, project_slug, cwd, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_request_cache_expiry ON request_cache(expires_at);
`;

export class CacheStore {
  readonly #dbPath: string;
  readonly #payloadRoot: string;
  readonly #projectSlug: string;
  #db: Database;
  #closed = false;
  #metricsStore: CacheMetricRecorder | null;
  #metricsSessionId: string;

  constructor(opts: CacheStoreOptions) {
    this.#dbPath = opts.dbPath;
    this.#payloadRoot = opts.payloadRoot;
    this.#projectSlug = opts.projectSlug;
    this.#metricsStore = opts.metricsStore ?? null;
    this.#metricsSessionId = opts.metricsSessionId ?? "(system)";

    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.#db = new Database(opts.dbPath);
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  get payloadRoot(): string {
    return this.#payloadRoot;
  }

  get projectSlug(): string {
    return this.#projectSlug;
  }

  init(): void {
    fs.mkdirSync(this.#payloadRoot, { recursive: true });
    this.#ensureDeleteJournalMode();
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  setMetricsRecorder(metricsStore: CacheMetricRecorder | null, metricsSessionId = "(system)"): void {
    this.#metricsStore = metricsStore;
    this.#metricsSessionId = metricsSessionId;
  }

  putText(input: PutCacheTextInput): PutCacheTextResult {
    this.#assertOpen();

    const now = input.now ?? Date.now();
    const bytes = Buffer.from(input.text, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const handle = renderCacheHandle(sha256);
    const preview = buildCachePreview(input.text, input.previewBytes);
    const payloadRelpath = path.join(sha256.slice(0, 2), `${sha256}.br`);
    const payloadPath = path.join(this.#payloadRoot, payloadRelpath);
    const compressed = brotliCompressSync(bytes);

    writePayloadAtomically(payloadPath, compressed);

    const tx = this.#db.transaction(() => {
      this.#db.prepare(
        `INSERT INTO cache_entries
           (handle, sha256, size_bytes, compressed_bytes, preview, payload_relpath, created_at, last_accessed_at, open_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(handle) DO UPDATE SET
             size_bytes = excluded.size_bytes,
             compressed_bytes = excluded.compressed_bytes,
             preview = excluded.preview,
             payload_relpath = excluded.payload_relpath,
             last_accessed_at = excluded.last_accessed_at`,
      ).run(
        handle,
        sha256,
        bytes.length,
        compressed.length,
        preview,
        payloadRelpath,
        now,
        now,
      );

      this.#db.prepare(
        `INSERT INTO cache_refs (handle, session_id, source_tool, source_hash, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(handle, session_id, source_tool, source_hash) DO UPDATE SET
             created_at = excluded.created_at`,
      ).run(
        handle,
        input.sessionId,
        input.sourceTool ?? "",
        input.sourceHash ?? "",
        now,
      );
    });
    tx();

    const meta = this.getEntryMeta(handle);
    if (!meta) {
      throw new Error("cache-store: failed to read metadata after cache write");
    }
    if (input.recordMetric !== false) {
      this.#recordCacheMetric({
        sessionId: input.sessionId,
        processor: "cache-store",
        beforeBytes: bytes.length,
        afterBytes: 0,
        cacheHit: 0,
      });
    }

    return meta;
  }

  openText(handle: string): OpenCacheTextResult {
    this.#assertOpen();

    const parsed = parseCacheHandle(handle);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: "invalid_handle",
        handle: null,
        message: `Cannot open cached content: ${parsed.message}.`,
      };
    }

    const metaBefore = this.#readEntryMeta(parsed.handle);
    if (!metaBefore) {
      return {
        ok: false,
        reason: "not_found",
        handle: parsed.handle,
        message: `Cannot open cached content: handle was not found: ${parsed.handle}.`,
      };
    }

    const payloadPath = path.join(this.#payloadRoot, metaBefore.payloadRelpath);
    if (!fs.existsSync(payloadPath)) {
      return {
        ok: false,
        reason: "missing_payload",
        handle: parsed.handle,
        message: `Cannot open cached content: payload file is missing for ${parsed.handle}.`,
      };
    }

    let text: string;
    try {
      text = brotliDecompressSync(fs.readFileSync(payloadPath)).toString("utf8");
    } catch {
      return {
        ok: false,
        reason: "corrupt_payload",
        handle: parsed.handle,
        message: `Cannot open cached content: payload is corrupt for ${parsed.handle}.`,
      };
    }

    const now = Date.now();
    this.#db.prepare(
      `UPDATE cache_entries
         SET last_accessed_at = ?, open_count = open_count + 1
         WHERE handle = ?`,
    ).run(now, parsed.handle);

    const meta = this.#readEntryMeta(parsed.handle) ?? metaBefore;
    return { ok: true, handle: parsed.handle, text, meta };
  }

  putRequestCache(input: RequestCachePutInput): void {
    this.#assertOpen();
    const now = input.now ?? Date.now();
    this.#db.prepare(
      `INSERT INTO request_cache
         (tool, args_hash, project_slug, cwd, fingerprint, handle, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool, args_hash, project_slug, cwd, fingerprint) DO UPDATE SET
         handle = excluded.handle,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    ).run(
      input.tool,
      input.argsHash,
      this.#projectSlug,
      input.cwd,
      input.fingerprint,
      input.handle,
      now,
      now + Math.max(0, Math.floor(input.ttlMs)),
    );
  }

  getRequestCache(input: RequestCacheLookupInput): RequestCacheLookupResult {
    this.#assertOpen();
    const now = input.now ?? Date.now();
    const row = this.#db.prepare(
      `SELECT handle, expires_at AS expiresAt
       FROM request_cache
       WHERE tool = ? AND args_hash = ? AND project_slug = ? AND cwd = ? AND fingerprint = ?`,
    ).get(input.tool, input.argsHash, this.#projectSlug, input.cwd, input.fingerprint) as
      | { handle: string; expiresAt: number }
      | undefined;
    if (!row) return { hit: false, reason: "miss" };
    if (row.expiresAt <= now) {
      this.#db.prepare(
        `DELETE FROM request_cache
         WHERE tool = ? AND args_hash = ? AND project_slug = ? AND cwd = ? AND fingerprint = ?`,
      ).run(input.tool, input.argsHash, this.#projectSlug, input.cwd, input.fingerprint);
      return { hit: false, reason: "expired" };
    }
    return { hit: true, handle: row.handle, expiresAt: row.expiresAt };
  }

  getEntryMeta(handle: string): CacheEntryMeta | null {
    this.#assertOpen();
    const parsed = parseCacheHandle(handle);
    if (!parsed.ok) return null;
    return this.#readEntryMeta(parsed.handle);
  }

  /**
   * List sessions that own at least one cache ref. Used by `/supi:clear` so
   * the project-wide confirmation is truthful when cache refs exist for
   * sessions that have no metrics rows.
   */
  listSessions(): { session_id: string; ref_count: number }[] {
    this.#assertOpen();
    return this.#db.prepare(
      `SELECT session_id, COUNT(*) AS ref_count
         FROM cache_refs
         GROUP BY session_id
         ORDER BY session_id`,
    ).all() as { session_id: string; ref_count: number }[];
  }

  clearSession(sessionId: string, _now = Date.now()): CacheClearResult {
    this.#assertOpen();
    const candidates = this.#db.prepare(
      `SELECT DISTINCT handle FROM cache_refs WHERE session_id = ?`,
    ).all(sessionId) as Array<{ handle: string }>;
    const handles = candidates.map((row) => row.handle);

    const deletedRefs = (this.#db.prepare(
      `DELETE FROM cache_refs WHERE session_id = ?`,
    ).run(sessionId).changes) as number;

    const gc = this.#garbageCollectHandles(handles);
    return {
      deletedRefs,
      deletedEntries: gc.deletedEntries,
      deletedPayloadBytes: gc.deletedPayloadBytes,
      retainedPayloadBytes: gc.retainedPayloadBytes,
    };
  }

  clearProject(_now = Date.now()): CacheClearResult {
    this.#assertOpen();
    const stats = this.getStats();
    const tx = this.#db.transaction(() => {
      this.#db.exec(`DELETE FROM cache_refs`);
      this.#db.exec(`DELETE FROM cache_entries`);
    });
    tx();

    fs.rmSync(this.#payloadRoot, { recursive: true, force: true });
    fs.mkdirSync(this.#payloadRoot, { recursive: true });

    return {
      deletedRefs: stats.refCount,
      deletedEntries: stats.entryCount,
      deletedPayloadBytes: stats.payloadBytes,
      retainedPayloadBytes: 0,
    };
  }

  pruneOldSessions(retentionDays: number, now = Date.now()): CacheClearResult {
    this.#assertOpen();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const candidates = this.#db.prepare(
      `SELECT DISTINCT handle FROM cache_refs WHERE created_at < ?`,
    ).all(cutoff) as Array<{ handle: string }>;
    const handles = candidates.map((row) => row.handle);

    const deletedRefs = (this.#db.prepare(
      `DELETE FROM cache_refs WHERE created_at < ?`,
    ).run(cutoff).changes) as number;

    const gc = this.#garbageCollectHandles(handles);
    this.#recordCacheMetric({
      sessionId: this.#metricsSessionId,
      processor: "cache-prune",
      beforeBytes: gc.deletedPayloadBytes + gc.retainedPayloadBytes,
      afterBytes: gc.retainedPayloadBytes,
      cacheHit: 0,
    });

    return {
      deletedRefs,
      deletedEntries: gc.deletedEntries,
      deletedPayloadBytes: gc.deletedPayloadBytes,
      retainedPayloadBytes: gc.retainedPayloadBytes,
    };
  }

  getSessionStats(sessionId: string): CacheSessionStats {
    this.#assertOpen();
    const refs = this.#db.prepare(
      `SELECT COUNT(*) AS refCount FROM cache_refs WHERE session_id = ?`,
    ).get(sessionId) as { refCount: number };

    const rows = this.#db.prepare(
      `SELECT
         e.handle,
         e.size_bytes AS sizeBytes,
         e.compressed_bytes AS compressedBytes,
         e.payload_relpath AS payloadRelpath,
         (SELECT COUNT(*) FROM cache_refs r WHERE r.handle = e.handle) AS totalRefs,
         (SELECT COUNT(*) FROM cache_refs r WHERE r.handle = e.handle AND r.session_id = ?) AS sessionRefs
       FROM cache_entries e
       WHERE e.handle IN (SELECT DISTINCT handle FROM cache_refs WHERE session_id = ?)`,
    ).all(sessionId, sessionId) as Array<{
      handle: string;
      sizeBytes: number;
      compressedBytes: number;
      payloadRelpath: string;
      totalRefs: number;
      sessionRefs: number;
    }>;

    let uncompressedBytes = 0;
    let compressedBytes = 0;
    let payloadBytes = 0;
    let reclaimablePayloadBytes = 0;
    let retainedPayloadBytes = 0;

    for (const row of rows) {
      uncompressedBytes += row.sizeBytes;
      compressedBytes += row.compressedBytes;
      const payloadSize = payloadBytesFor(path.join(this.#payloadRoot, row.payloadRelpath), row.compressedBytes);
      payloadBytes += payloadSize;
      if (row.totalRefs - row.sessionRefs <= 0) {
        reclaimablePayloadBytes += payloadSize;
      } else {
        retainedPayloadBytes += payloadSize;
      }
    }

    return {
      entryCount: rows.length,
      refCount: refs.refCount,
      uncompressedBytes,
      compressedBytes,
      payloadBytes,
      reclaimablePayloadBytes,
      retainedPayloadBytes,
    };
  }

  getStats(): CacheStats {
    this.#assertOpen();
    const entries = this.#db.prepare(
      `SELECT
         COUNT(*) AS entryCount,
         COALESCE(SUM(size_bytes), 0) AS uncompressedBytes,
         COALESCE(SUM(compressed_bytes), 0) AS compressedBytes
       FROM cache_entries`,
    ).get() as {
      entryCount: number;
      uncompressedBytes: number;
      compressedBytes: number;
    };
    const refs = this.#db.prepare(
      `SELECT COUNT(*) AS refCount FROM cache_refs`,
    ).get() as { refCount: number };

    return {
      entryCount: entries.entryCount,
      refCount: refs.refCount,
      uncompressedBytes: entries.uncompressedBytes,
      compressedBytes: entries.compressedBytes,
      payloadBytes: sumPayloadBytes(this.#payloadRoot),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    try {
      try {
        if (this.#getJournalMode() === "wal") {
          this.#cleanupWalSidecars();
        }
      } catch {
        // The DB path may already be gone during teardown.
      }
    } finally {
      this.#db.close();
    }
  }

  #ensureDeleteJournalMode(): void {
    const journalMode = this.#getJournalMode();
    if (journalMode === "delete") return;

    if (journalMode === "wal") {
      this.#cleanupWalSidecars();
    }

    try {
      this.#db.exec("PRAGMA journal_mode = DELETE;");
    } catch {
      // Best effort only. close() still checkpoints WAL stores when possible.
    }
  }

  #getJournalMode(): string {
    const { journal_mode } = this.#db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    return journal_mode.toLowerCase();
  }

  #cleanupWalSidecars(): void {
    try {
      this.#db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Best effort only.
    }
  }

  #migrate(): void {
    const { user_version } = this.#db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (user_version === SCHEMA_VERSION) return;
    if (user_version > SCHEMA_VERSION) {
      throw new Error(
        `cache-store: unknown schema version ${user_version} (max supported: ${SCHEMA_VERSION})`,
      );
    }

    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  #readEntryMeta(handle: string): CacheEntryMeta | null {
    const row = this.#db.prepare(
      `SELECT
         handle,
         sha256,
         size_bytes AS sizeBytes,
         compressed_bytes AS compressedBytes,
         preview,
         payload_relpath AS payloadRelpath,
         created_at AS createdAt,
         last_accessed_at AS lastAccessedAt,
         open_count AS openCount
       FROM cache_entries
       WHERE handle = ?`,
    ).get(handle) as CacheEntryMeta | undefined;
    return row ?? null;
  }

  #garbageCollectHandles(handles: string[]): Omit<CacheClearResult, "deletedRefs"> {
    let deletedEntries = 0;
    let deletedPayloadBytes = 0;
    let retainedPayloadBytes = 0;

    const uniqueHandles = [...new Set(handles)];
    for (const handle of uniqueHandles) {
      const meta = this.#readEntryMeta(handle);
      if (!meta) continue;

      const remaining = this.#db.prepare(
        `SELECT COUNT(*) AS count FROM cache_refs WHERE handle = ?`,
      ).get(handle) as { count: number };

      if (remaining.count > 0) {
        retainedPayloadBytes += meta.compressedBytes;
        continue;
      }

      this.#db.prepare(`DELETE FROM cache_entries WHERE handle = ?`).run(handle);
      deletedEntries += 1;

      const payloadPath = path.join(this.#payloadRoot, meta.payloadRelpath);
      if (fs.existsSync(payloadPath)) {
        const size = fs.statSync(payloadPath).size;
        fs.rmSync(payloadPath, { force: true });
        deletedPayloadBytes += size;
      } else {
        deletedPayloadBytes += meta.compressedBytes;
      }
      removeEmptyParentDirectory(path.dirname(payloadPath), this.#payloadRoot);
    }

    return { deletedEntries, deletedPayloadBytes, retainedPayloadBytes };
  }

  #recordCacheMetric(opts: {
    sessionId: string;
    processor: "cache-store" | "cache-prune";
    beforeBytes: number;
    afterBytes: number;
    cacheHit: 0 | 1;
  }): void {
    const metrics = this.#metricsStore;
    if (!metrics) return;

    try {
      metrics.record({
        session_id: opts.sessionId,
        ts: Date.now(),
        layer: "L3",
        tool: "(system)",
        processor: opts.processor,
        before_bytes: Math.max(0, Math.floor(opts.beforeBytes)),
        after_bytes: Math.max(0, Math.floor(opts.afterBytes)),
        cache_hit: opts.cacheHit,
        unique_source_hash: null,
        context_tokens: null,
        context_window: null,
        context_percent: null,
      });
    } catch {
      // Cache operations must not depend on metrics health.
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("cache-store: operation attempted after close");
    }
  }
}

function payloadBytesFor(payloadPath: string, fallbackBytes: number): number {
  try {
    return fs.statSync(payloadPath).size;
  } catch {
    return fallbackBytes;
  }
}

function sumPayloadBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;

  let total = 0;
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, dirent.name);
    if (dirent.isDirectory()) {
      total += sumPayloadBytes(fullPath);
    } else if (dirent.isFile()) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}


function writePayloadAtomically(payloadPath: string, bytes: Buffer): void {
  if (fs.existsSync(payloadPath)) return;

  fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
  const tempPath = `${payloadPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, bytes, { flag: "wx" });
    try {
      fs.renameSync(tempPath, payloadPath);
    } catch (error) {
      if (fs.existsSync(payloadPath)) {
        fs.rmSync(tempPath, { force: true });
        return;
      }
      throw error;
    }
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function removeEmptyParentDirectory(candidate: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(candidate);
  while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}