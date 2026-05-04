// src/context-mode/memory-store.ts
//
// L5 cross-session memory store. Keeps durable observations/decisions/tasks
// per project under <projectStateDir>/sessions/memory.db. Mirrors the
// event-store/metrics-store conventions: DELETE journal mode, idempotent
// migration, best-effort failures, content-addressed dedup, and bounded
// retrieval.
//
// Privacy contract:
// - Every row carries an explicit `owner_scope` (`session` | `project`) and
//   `owner_id`. Session clear deletes session-owned rows for the active
//   session and stamps a clear epoch so project-owned rows that pre-date the
//   epoch are filtered out of subsequent injection for that session.
// - Project clear deletes every row and every epoch for the project.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SCHEMA_VERSION = 1;

export type MemoryOwnerScope = "session" | "project";
export type MemoryType = "observation" | "decision" | "task";

export interface MemoryStoreOptions {
  dbPath: string;
  projectSlug: string;
}

export interface MemoryRow {
  id: number;
  ownerScope: MemoryOwnerScope;
  ownerId: string;
  type: MemoryType;
  body: string;
  bodyHash: string;
  priority: number;
  createdAt: number;
}

export interface MemoryPutInput {
  ownerScope: MemoryOwnerScope;
  ownerId?: string;
  type: MemoryType;
  body: string;
  priority?: number;
  now?: number;
}

export interface MemoryRetrieveOptions {
  sessionId: string;
  byteBudget?: number;
  limit?: number;
  now?: number;
}

const DEFAULT_PRIORITY = 3;
const DEFAULT_BYTE_BUDGET = 4 * 1024;
const DEFAULT_LIMIT = 25;
const RETENTION_DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_scope TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_scope, owner_id, type, body_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_owner ON memory_entries(owner_scope, owner_id);
CREATE INDEX IF NOT EXISTS idx_memory_priority ON memory_entries(priority, created_at);

CREATE TABLE IF NOT EXISTS memory_clear_epochs (
  session_id TEXT PRIMARY KEY,
  cleared_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_meta (
  project_slug TEXT PRIMARY KEY,
  last_prune_at INTEGER,
  last_project_clear_at INTEGER
);
`;

export class MemoryStore {
  readonly #dbPath: string;
  readonly #projectSlug: string;
  #db: Database;
  #closed = false;

  constructor(opts: MemoryStoreOptions) {
    this.#dbPath = opts.dbPath;
    this.#projectSlug = opts.projectSlug;
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.#db = new Database(opts.dbPath);
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  get projectSlug(): string {
    return this.#projectSlug;
  }

  init(): void {
    try {
      this.#db.exec("PRAGMA journal_mode = DELETE;");
    } catch {
      // Older WAL-backed databases stay on WAL until close().
    }
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  #migrate(): void {
    const { user_version } = this.#db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (user_version === SCHEMA_VERSION) return;
    if (user_version > SCHEMA_VERSION) {
      throw new Error(
        `memory-store: unknown schema version ${user_version} (max supported: ${SCHEMA_VERSION})`,
      );
    }
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  put(input: MemoryPutInput): MemoryRow | null {
    this.#assertOpen();
    const body = input.body.trim();
    if (!body) return null;
    const ownerId = input.ownerScope === "session" ? input.ownerId ?? "" : "";
    const bodyHash = sha256(body);
    const now = input.now ?? Date.now();
    const priority = clampPriority(input.priority ?? DEFAULT_PRIORITY);

    this.#db.prepare(
      `INSERT INTO memory_entries (owner_scope, owner_id, type, body, body_hash, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_scope, owner_id, type, body_hash) DO UPDATE SET
         priority = MIN(memory_entries.priority, excluded.priority),
         created_at = excluded.created_at`,
    ).run(input.ownerScope, ownerId, input.type, body, bodyHash, priority, now);

    return this.#readRowByKey(input.ownerScope, ownerId, input.type, bodyHash);
  }

  retrieve(options: MemoryRetrieveOptions): MemoryRow[] {
    this.#assertOpen();
    const byteBudget = Math.max(0, options.byteBudget ?? DEFAULT_BYTE_BUDGET);
    if (byteBudget === 0) return [];
    const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const epoch = this.#readClearEpoch(options.sessionId);

    const sql = `
      SELECT id, owner_scope AS ownerScope, owner_id AS ownerId, type, body,
             body_hash AS bodyHash, priority, created_at AS createdAt
      FROM memory_entries
      WHERE (
        (owner_scope = 'session' AND owner_id = ?)
        OR (owner_scope = 'project' AND created_at > ?)
      )
      ORDER BY priority ASC, created_at DESC
      LIMIT ?
    `;
    const rows = this.#db.prepare(sql).all(options.sessionId, epoch, limit) as MemoryRow[];

    const collected: MemoryRow[] = [];
    let used = 0;
    for (const row of rows) {
      const cost = byteLength(row.body);
      if (used + cost > byteBudget) continue;
      used += cost;
      collected.push(row);
    }
    return collected;
  }

  recordClearEpoch(sessionId: string, now = Date.now()): void {
    this.#assertOpen();
    this.#db.prepare(
      `INSERT INTO memory_clear_epochs (session_id, cleared_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET cleared_at = excluded.cleared_at`,
    ).run(sessionId, now);
  }

  clearSession(sessionId: string, now = Date.now()): { deleted: number } {
    this.#assertOpen();
    const deleted = this.#db.prepare(
      `DELETE FROM memory_entries WHERE owner_scope = 'session' AND owner_id = ?`,
    ).run(sessionId).changes as number;
    this.recordClearEpoch(sessionId, now);
    return { deleted };
  }

  clearProject(now = Date.now()): { deleted: number } {
    this.#assertOpen();
    const stats = this.#db.prepare("SELECT COUNT(*) AS cnt FROM memory_entries").get() as {
      cnt: number;
    };
    this.#db.exec("DELETE FROM memory_entries");
    this.#db.exec("DELETE FROM memory_clear_epochs");
    this.#db.prepare(
      `INSERT INTO memory_meta (project_slug, last_project_clear_at)
       VALUES (?, ?)
       ON CONFLICT(project_slug) DO UPDATE SET last_project_clear_at = excluded.last_project_clear_at`,
    ).run(this.#projectSlug, now);
    return { deleted: stats.cnt };
  }

  pruneOld(retentionDays = RETENTION_DAYS, now = Date.now()): number {
    this.#assertOpen();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = this.#db.prepare(
      `DELETE FROM memory_entries WHERE created_at < ?`,
    ).run(cutoff).changes as number;
    this.#db.prepare(
      `INSERT INTO memory_meta (project_slug, last_prune_at)
       VALUES (?, ?)
       ON CONFLICT(project_slug) DO UPDATE SET last_prune_at = excluded.last_prune_at`,
    ).run(this.#projectSlug, now);
    return deleted;
  }

  getStats(): { totalRows: number; sessionRows: number; projectRows: number } {
    this.#assertOpen();
    const total = this.#db.prepare(
      "SELECT COUNT(*) AS cnt FROM memory_entries",
    ).get() as { cnt: number };
    const sessionRows = this.#db.prepare(
      "SELECT COUNT(*) AS cnt FROM memory_entries WHERE owner_scope = 'session'",
    ).get() as { cnt: number };
    const projectRows = this.#db.prepare(
      "SELECT COUNT(*) AS cnt FROM memory_entries WHERE owner_scope = 'project'",
    ).get() as { cnt: number };
    return {
      totalRows: total.cnt,
      sessionRows: sessionRows.cnt,
      projectRows: projectRows.cnt,
    };
  }

  countSessionRows(sessionId: string): number {
    this.#assertOpen();
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS cnt FROM memory_entries WHERE owner_scope = 'session' AND owner_id = ?",
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  listSessions(): { session_id: string; row_count: number }[] {
    this.#assertOpen();
    return this.#db.prepare(
      `SELECT owner_id AS session_id, COUNT(*) AS row_count
         FROM memory_entries
        WHERE owner_scope = 'session'
        GROUP BY owner_id
        ORDER BY owner_id`,
    ).all() as Array<{ session_id: string; row_count: number }>;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #readRowByKey(
    ownerScope: MemoryOwnerScope,
    ownerId: string,
    type: MemoryType,
    bodyHash: string,
  ): MemoryRow | null {
    return (this.#db.prepare(
      `SELECT id, owner_scope AS ownerScope, owner_id AS ownerId, type, body,
              body_hash AS bodyHash, priority, created_at AS createdAt
       FROM memory_entries
       WHERE owner_scope = ? AND owner_id = ? AND type = ? AND body_hash = ?`,
    ).get(ownerScope, ownerId, type, bodyHash) as MemoryRow | undefined) ?? null;
  }

  #readClearEpoch(sessionId: string): number {
    const row = this.#db.prepare(
      `SELECT cleared_at AS clearedAt FROM memory_clear_epochs WHERE session_id = ?`,
    ).get(sessionId) as { clearedAt: number } | undefined;
    return row?.clearedAt ?? 0;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("memory-store: cannot use a closed store");
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clampPriority(priority: number): number {
  if (!Number.isFinite(priority)) return DEFAULT_PRIORITY;
  return Math.min(5, Math.max(1, Math.floor(priority)));
}

let _memoryStoreRef: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore | null {
  return _memoryStoreRef;
}

export function _setMemoryStoreRef(store: MemoryStore | null): void {
  _memoryStoreRef = store;
}
