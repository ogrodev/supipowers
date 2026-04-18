import { constants, Database } from "bun:sqlite";
import fs from "node:fs";
import type { Chunk } from "./chunker.js";

export interface SearchOptions {
  source?: string;
  contentType?: "code" | "prose";
  limit?: number;
}

export interface SearchResult {
  title: string;
  body: string;
  source: string;
  contentType: string;
  score: number;
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS content_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'prose'
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

CREATE TABLE IF NOT EXISTS url_cache (
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (url, source)
);
`;

export class KnowledgeStore {
  private _db: Database;
  private dbPath: string;
  #closed = false;

  /** Public accessor for direct SQL on extension tables (e.g. url_cache). */
  get db(): Database {
    return this._db;
  }

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this._db = new Database(dbPath);
  }

  init(): void {
    this.#ensureDeleteJournalMode();
    this._db.exec(SCHEMA);
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
  index(chunks: Chunk[], source: string): void {
    const del = this._db.prepare("DELETE FROM content_chunks WHERE source = ?");
    const ins = this._db.prepare(
      "INSERT INTO content_chunks (source, title, body, content_type) VALUES (?, ?, ?, ?)",
    );

    this._db.transaction(() => {
      del.run(source);
      for (const chunk of chunks) {
        ins.run(source, chunk.title, chunk.body, chunk.contentType);
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
    return result.changes;
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

/** Strip FTS5 special operators to prevent syntax errors. Keep alphanumeric + spaces. */
function sanitizeFtsQuery(query: string): string {
  // Remove characters that have special meaning in FTS5: ^, *, ", (, ), {, }, +, -
  // Keep words separated by spaces for implicit AND matching
  return query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
