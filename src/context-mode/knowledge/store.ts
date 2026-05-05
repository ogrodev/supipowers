import { constants, Database } from "bun:sqlite";
import fs from "node:fs";
import type { KnowledgeOwner, KnowledgeOwnerScope } from "../../types.js";
import type { Chunk } from "./chunker.js";

export interface SearchOptions {
  source?: string;
  contentType?: "code" | "prose";
  limit?: number;
  owner?: KnowledgeOwner;
  includeAllSessions?: boolean;
}

export interface SearchResult {
  title: string;
  body: string;
  source: string;
  contentType: string;
  score: number;
  ownerScope: KnowledgeOwnerScope;
  ownerId: string;
}

export interface QueryGroupedResults {
  query: string;
  results: SearchResult[];
}

export interface StoreStats {
  totalChunks: number;
  sources: string[];
  dbSizeBytes: number;
}

export interface KnowledgeClearResult {
  chunksDeleted: number;
  urlCacheDeleted: number;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS content_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'prose',
  owner_scope TEXT NOT NULL DEFAULT 'project',
  owner_id TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS content_chunks_fts USING fts5(
  title,
  body,
  content='content_chunks',
  content_rowid='id',
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS content_chunks_ai AFTER INSERT ON content_chunks BEGIN
  INSERT INTO content_chunks_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS content_chunks_ad AFTER DELETE ON content_chunks BEGIN
  INSERT INTO content_chunks_fts(content_chunks_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;

CREATE INDEX IF NOT EXISTS idx_content_chunks_owner ON content_chunks(owner_scope, owner_id);
CREATE INDEX IF NOT EXISTS idx_content_chunks_source_owner ON content_chunks(source, owner_scope, owner_id);

CREATE TABLE IF NOT EXISTS url_cache (
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  owner_scope TEXT NOT NULL DEFAULT 'project',
  owner_id TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (url, source, owner_scope, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_url_cache_owner ON url_cache(owner_scope, owner_id);
`;

const PROJECT_OWNER: Required<KnowledgeOwner> = { ownerScope: "project", ownerId: "" };

export class KnowledgeStore {
  private _db: Database;
  private dbPath: string;
  #closed = false;

  /** Public accessor for direct SQL on extension tables (e.g. url_cache). */
  get db(): Database {
    return this._db;
  }

  get path(): string {
    return this.dbPath;
  }

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this._db = new Database(dbPath);
  }

  init(): void {
    this.#ensureDeleteJournalMode();
    this.#migrate();
    this._db.exec(SCHEMA);
    this._db.exec("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES('rebuild')");
  }

  #ensureDeleteJournalMode(): void {
    const journalMode = this.#getJournalMode();
    if (journalMode === "delete") return;

    if (journalMode === "wal") {
      this.#cleanupWalSidecars();
    }

    try {
      this._db.exec("PRAGMA journal_mode = DELETE");
    } catch {
      // Older WAL-backed databases can stay on WAL for this process.
      // close() still checkpoints them so teardown and the next reopen succeed.
    }
  }

  #getJournalMode(): string {
    const { journal_mode } = this._db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    return journal_mode.toLowerCase();
  }

  #cleanupWalSidecars(): void {
    try {
      this._db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      this._db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best effort only: close() still releases the handle in finally.
    }
  }

  #migrate(): void {
    const { user_version } = this._db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (user_version >= SCHEMA_VERSION) return;

    const hasContentChunks = tableExists(this._db, "content_chunks");
    if (hasContentChunks) {
      addColumnIfMissing(this._db, "content_chunks", "owner_scope", "TEXT NOT NULL DEFAULT 'legacy'");
      addColumnIfMissing(this._db, "content_chunks", "owner_id", "TEXT NOT NULL DEFAULT ''");
      this._db.prepare(
        `UPDATE content_chunks
         SET owner_scope = 'legacy'
         WHERE owner_scope IS NULL OR owner_scope = ''`,
      ).run();
    }

    const hasUrlCache = tableExists(this._db, "url_cache");
    if (hasUrlCache && !columnExists(this._db, "url_cache", "owner_scope")) {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS url_cache_v2 (
          url TEXT NOT NULL,
          source TEXT NOT NULL,
          owner_scope TEXT NOT NULL DEFAULT 'legacy',
          owner_id TEXT NOT NULL DEFAULT '',
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (url, source, owner_scope, owner_id)
        );
        INSERT OR REPLACE INTO url_cache_v2 (url, source, owner_scope, owner_id, fetched_at)
          SELECT url, source, 'legacy', '', fetched_at FROM url_cache;
        DROP TABLE url_cache;
        ALTER TABLE url_cache_v2 RENAME TO url_cache;
      `);
    }

    this._db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  index(chunks: Chunk[], source: string, owner?: KnowledgeOwner): void {
    const resolvedOwner = normalizeOwner(owner);
    const del = this._db.prepare(
      `DELETE FROM content_chunks
       WHERE source = ?
         AND (
           (owner_scope = ? AND owner_id = ?)
           OR (? = 'project' AND owner_scope = 'legacy')
         )`,
    );
    const ins = this._db.prepare(
      `INSERT INTO content_chunks (source, title, body, content_type, owner_scope, owner_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this._db.transaction(() => {
      del.run(source, resolvedOwner.ownerScope, resolvedOwner.ownerId, resolvedOwner.ownerScope);
      for (const chunk of chunks) {
        ins.run(
          source,
          chunk.title,
          chunk.body,
          chunk.contentType,
          resolvedOwner.ownerScope,
          resolvedOwner.ownerId,
        );
      }
    })();
  }

  search(queries: string[], options?: SearchOptions): QueryGroupedResults[] {
    if (!queries.length) return [];

    const limit = options?.limit ?? 3;
    const results: QueryGroupedResults[] = [];

    for (const query of queries) {
      const sanitized = sanitizeFtsQuery(query);
      if (!sanitized) {
        results.push({ query, results: [] });
        continue;
      }

      let sql = `
        SELECT c.title, c.body, c.source, c.content_type AS contentType,
               c.owner_scope AS ownerScope,
               c.owner_id AS ownerId,
               bm25(content_chunks_fts, 5.0, 1.0) AS score
        FROM content_chunks_fts f
        JOIN content_chunks c ON c.id = f.rowid
        WHERE content_chunks_fts MATCH ?
      `;
      const params: (string | number)[] = [sanitized];

      if (options?.source) {
        sql += " AND c.source LIKE '%' || ? || '%'";
        params.push(options.source);
      }
      if (options?.contentType) {
        sql += " AND c.content_type = ?";
        params.push(options.contentType);
      }

      const visibility = buildVisibilityClause(options);
      if (visibility) {
        sql += ` AND ${visibility.sql}`;
        params.push(...visibility.params);
      }

      sql += " ORDER BY score LIMIT ?";
      params.push(limit);

      try {
        const rows = this._db.prepare(sql).all(...params) as SearchResult[];
        results.push({ query, results: rows });
      } catch {
        // FTS5 query syntax error — return empty for this query
        results.push({ query, results: [] });
      }
    }

    return results;
  }

  purge(): number {
    const row = this._db.prepare("SELECT COUNT(*) AS cnt FROM content_chunks").get() as {
      cnt: number;
    };
    const count = row.cnt;
    this._db.exec("DELETE FROM content_chunks");
    this._db.exec("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES('rebuild')");
    this._db.exec("DELETE FROM url_cache");
    return count;
  }

  listSessions(): { session_id: string; chunk_count: number; url_cache_count: number }[] {
    const merged = new Map<string, { session_id: string; chunk_count: number; url_cache_count: number }>();
    const chunkRows = this._db.prepare(
      `SELECT owner_id AS session_id, COUNT(*) AS chunk_count
         FROM content_chunks
        WHERE owner_scope = 'session'
        GROUP BY owner_id`,
    ).all() as Array<{ session_id: string; chunk_count: number }>;
    const urlRows = this._db.prepare(
      `SELECT owner_id AS session_id, COUNT(*) AS url_cache_count
         FROM url_cache
        WHERE owner_scope = 'session'
        GROUP BY owner_id`,
    ).all() as Array<{ session_id: string; url_cache_count: number }>;

    for (const row of chunkRows) {
      merged.set(row.session_id, {
        session_id: row.session_id,
        chunk_count: row.chunk_count,
        url_cache_count: 0,
      });
    }
    for (const row of urlRows) {
      const existing = merged.get(row.session_id);
      if (existing) {
        existing.url_cache_count = row.url_cache_count;
      } else {
        merged.set(row.session_id, {
          session_id: row.session_id,
          chunk_count: 0,
          url_cache_count: row.url_cache_count,
        });
      }
    }
    return [...merged.values()].sort((a, b) => a.session_id.localeCompare(b.session_id));
  }

  clearSession(ownerId: string): KnowledgeClearResult {
    const chunks = this._db.prepare(
      "SELECT COUNT(*) AS cnt FROM content_chunks WHERE owner_scope = 'session' AND owner_id = ?",
    ).get(ownerId) as { cnt: number };
    const urls = this._db.prepare(
      "SELECT COUNT(*) AS cnt FROM url_cache WHERE owner_scope = 'session' AND owner_id = ?",
    ).get(ownerId) as { cnt: number };
    this._db.prepare(
      "DELETE FROM content_chunks WHERE owner_scope = 'session' AND owner_id = ?",
    ).run(ownerId);
    this._db.prepare(
      "DELETE FROM url_cache WHERE owner_scope = 'session' AND owner_id = ?",
    ).run(ownerId);
    this._db.exec("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES('rebuild')");
    return { chunksDeleted: chunks.cnt, urlCacheDeleted: urls.cnt };
  }

  clearProject(): KnowledgeClearResult {
    const chunks = this._db.prepare("SELECT COUNT(*) AS cnt FROM content_chunks").get() as {
      cnt: number;
    };
    const urls = this._db.prepare("SELECT COUNT(*) AS cnt FROM url_cache").get() as {
      cnt: number;
    };
    this._db.exec("DELETE FROM content_chunks");
    this._db.exec("DELETE FROM url_cache");
    this._db.exec("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES('rebuild')");
    return { chunksDeleted: chunks.cnt, urlCacheDeleted: urls.cnt };
  }

  getStats(): StoreStats {
    const countRow = this._db.prepare("SELECT COUNT(*) AS cnt FROM content_chunks").get() as {
      cnt: number;
    };
    const sourceRows = this._db
      .prepare("SELECT DISTINCT source FROM content_chunks ORDER BY source")
      .all() as { source: string }[];
    const dbSizeBytes = fs.statSync(this.dbPath).size;

    return {
      totalChunks: countRow.cnt,
      sources: sourceRows.map((r) => r.source),
      dbSizeBytes,
    };
  }

  pruneExpiredUrls(ttlHours = 24): number {
    const cutoff = Math.floor(Date.now() / 1000) - ttlHours * 3600;
    const result = this._db.prepare("DELETE FROM url_cache WHERE fetched_at < ?").run(cutoff);
    return result.changes as number;
  }

  close(): void {
    if (this.#closed) return;

    try {
      try {
        if (this.#getJournalMode() === "wal") {
          this.#cleanupWalSidecars();
        }
      } catch {
        // The DB path may already be gone during teardown; still close the handle.
      }
    } finally {
      this._db.close();
      this.#closed = true;
    }
  }
}

function normalizeOwner(owner: KnowledgeOwner | undefined): Required<KnowledgeOwner> {
  if (!owner) return PROJECT_OWNER;
  return {
    ownerScope: owner.ownerScope,
    ownerId: owner.ownerScope === "session" ? owner.ownerId ?? "" : owner.ownerId ?? "",
  };
}

function buildVisibilityClause(options: SearchOptions | undefined): { sql: string; params: string[] } | null {
  if (options?.includeAllSessions) return null;

  const owner = options?.owner;
  if (owner?.ownerScope === "session") {
    return {
      sql: "(c.owner_scope IN ('project', 'legacy') OR (c.owner_scope = 'session' AND c.owner_id = ?))",
      params: [owner.ownerId ?? ""],
    };
  }

  return {
    sql: "c.owner_scope IN ('project', 'legacy')",
    params: [],
  };
}

function tableExists(db: Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) != null;
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Strip FTS5 special operators to prevent syntax errors. Keep alphanumeric + spaces. */
function sanitizeFtsQuery(query: string): string {
  // Remove characters that have special meaning in FTS5: ^, *, ", (, ), {, }, +, -
  // Keep words separated by spaces for implicit AND matching
  return query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
