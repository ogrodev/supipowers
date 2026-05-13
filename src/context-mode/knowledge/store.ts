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

export type SearchMatchLayer = "porter" | "trigram" | "rrf" | "rrf-fuzzy";

export interface SearchResult {
  title: string;
  body: string;
  source: string;
  contentType: string;
  score: number;
  ownerScope: KnowledgeOwnerScope;
  ownerId: string;
  /** Which layer of the fallback chain surfaced this row. Optional for backward compat. */
  matchLayer?: SearchMatchLayer;
}

interface RankedSearchResult extends SearchResult {
  chunkId: number;
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

const SCHEMA_VERSION = 3;

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

CREATE VIRTUAL TABLE IF NOT EXISTS content_chunks_trigram USING fts5(
  title,
  body,
  content='content_chunks',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS vocabulary (
  word TEXT PRIMARY KEY
);

CREATE TRIGGER IF NOT EXISTS content_chunks_ai AFTER INSERT ON content_chunks BEGIN
  INSERT INTO content_chunks_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
  INSERT INTO content_chunks_trigram(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS content_chunks_ad AFTER DELETE ON content_chunks BEGIN
  INSERT INTO content_chunks_fts(content_chunks_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO content_chunks_trigram(content_chunks_trigram, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
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
    this._db.exec("INSERT INTO content_chunks_trigram(content_chunks_trigram) VALUES('rebuild')");
    this.#backfillVocabularyIfNeeded();
  }

  /**
   * Populate `vocabulary` from existing chunks when it is empty but the store
   * is not. Runs once on the first init() after a v2 → v3 migration; a no-op
   * for fresh stores (no chunks) and for already-populated stores.
   */
  #backfillVocabularyIfNeeded(): void {
    const vocabCount = this._db.prepare("SELECT COUNT(*) AS cnt FROM vocabulary").get() as { cnt: number };
    if (vocabCount.cnt > 0) return;

    const chunkCount = this._db.prepare("SELECT COUNT(*) AS cnt FROM content_chunks").get() as { cnt: number };
    if (chunkCount.cnt === 0) return;

    const ins = this._db.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)");
    const rows = this._db
      .prepare("SELECT title, body FROM content_chunks")
      .iterate() as IterableIterator<{ title: string; body: string }>;
    this._db.transaction(() => {
      for (const row of rows) {
        for (const word of extractVocabWords(`${row.title}\n${row.body}`)) {
          ins.run(word);
        }
      }
    })();
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

    if (user_version < 3) {
      // v2 → v3: the INSERT/DELETE triggers now also fan out to
      // `content_chunks_trigram`. Drop the legacy single-table triggers so the
      // idempotent CREATE TRIGGER IF NOT EXISTS in `SCHEMA` reinstalls the
      // multi-table versions. Trigram + vocab backfill happen in init().
      this._db.exec(`DROP TRIGGER IF EXISTS content_chunks_ai;`);
      this._db.exec(`DROP TRIGGER IF EXISTS content_chunks_ad;`);
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
    const vocabIns = this._db.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)");

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
        for (const word of extractVocabWords(`${chunk.title}\n${chunk.body}`)) {
          vocabIns.run(word);
        }
      }
    })();
  }

  search(queries: string[], options?: SearchOptions): QueryGroupedResults[] {
    if (!queries.length) return [];

    const limit = options?.limit ?? 3;
    const results: QueryGroupedResults[] = [];

    for (const query of queries) {
      const tokens = tokenizeQuery(query);
      if (tokens.length === 0) {
        results.push({ query, results: [] });
        continue;
      }

      const fetchLimit = Math.max(limit * 2, 10);
      const porterRows = this.#runFts("content_chunks_fts", buildOrQuery(tokens), fetchLimit, options);
      const trigramRows = this.#runFts("content_chunks_trigram", buildOrQuery(tokens.filter(t => t.length >= 3)), fetchLimit, options);

      let fused = rrfFuse(porterRows, trigramRows, limit, "rrf");

      if (fused.length === 0) {
        const corrected = this.#fuzzyCorrectTokens(tokens);
        if (corrected && corrected.join(" ") !== tokens.join(" ")) {
          const porter2 = this.#runFts("content_chunks_fts", buildOrQuery(corrected), fetchLimit, options);
          const trigram2 = this.#runFts("content_chunks_trigram", buildOrQuery(corrected.filter(t => t.length >= 3)), fetchLimit, options);
          fused = rrfFuse(porter2, trigram2, limit, "rrf-fuzzy");
        }
      }

      const reranked = applyProximityReranking(fused, tokens);
      results.push({ query, results: reranked });
    }

    return results;
  }

  /**
   * Run one FTS5 MATCH query against `table` with the standard source /
   * contentType / visibility filters. Returns empty on FTS5 syntax errors so
   * a single bad token in a multi-query call cannot break sibling queries.
   */
  #runFts(
    table: "content_chunks_fts" | "content_chunks_trigram",
    matchExpr: string,
    limit: number,
    options: SearchOptions | undefined,
  ): RankedSearchResult[] {
    if (!matchExpr) return [];

    const sql: string[] = [
      `SELECT c.id AS chunkId, c.title, c.body, c.source, c.content_type AS contentType,`,
      `       c.owner_scope AS ownerScope,`,
      `       c.owner_id AS ownerId,`,
      `       bm25(${table}, 5.0, 1.0) AS score`,
      `FROM ${table} f`,
      `JOIN content_chunks c ON c.id = f.rowid`,
      `WHERE ${table} MATCH ?`,
    ];
    const params: (string | number)[] = [matchExpr];

    if (options?.source) {
      sql.push("AND c.source LIKE '%' || ? || '%'");
      params.push(options.source);
    }
    if (options?.contentType) {
      sql.push("AND c.content_type = ?");
      params.push(options.contentType);
    }

    const visibility = buildVisibilityClause(options);
    if (visibility) {
      sql.push(`AND ${visibility.sql}`);
      params.push(...visibility.params);
    }

    sql.push("ORDER BY score LIMIT ?");
    params.push(limit);

    try {
      return this._db.prepare(sql.join("\n")).all(...params) as RankedSearchResult[];
    } catch {
      return [];
    }
  }

  /**
   * Try to repair each token via Levenshtein lookup against `vocabulary`.
   * Returns null when nothing was corrected (caller skips fuzzy retry).
   */
  #fuzzyCorrectTokens(tokens: string[]): string[] | null {
    const candidatesByLen = this._db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    );
    const corrected: string[] = [];
    let changed = false;
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower.length < 3) {
        corrected.push(token);
        continue;
      }
      const maxDist = maxEditDistance(lower.length);
      const candidates = candidatesByLen.all(lower.length - maxDist, lower.length + maxDist) as Array<{ word: string }>;
      let best: string | null = null;
      let bestDist = maxDist + 1;
      let exact = false;
      for (const { word } of candidates) {
        if (word === lower) { exact = true; break; }
        const dist = levenshtein(lower, word);
        if (dist < bestDist) {
          bestDist = dist;
          best = word;
        }
      }
      if (exact) {
        corrected.push(token);
        continue;
      }
      if (best && bestDist <= maxDist) {
        corrected.push(best);
        changed = true;
      } else {
        corrected.push(token);
      }
    }
    return changed ? corrected : null;
  }

  purge(): number {
    const row = this._db.prepare("SELECT COUNT(*) AS cnt FROM content_chunks").get() as {
      cnt: number;
    };
    const count = row.cnt;
    this._db.exec("DELETE FROM content_chunks");
    this._db.exec("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES('rebuild')");
    this._db.exec("INSERT INTO content_chunks_trigram(content_chunks_trigram) VALUES('rebuild')");
    this._db.exec("DELETE FROM vocabulary");
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
    this._db.exec("INSERT INTO content_chunks_trigram(content_chunks_trigram) VALUES('rebuild')");
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
    this._db.exec("INSERT INTO content_chunks_trigram(content_chunks_trigram) VALUES('rebuild')");
    this._db.exec("DELETE FROM vocabulary");
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

// ── Tokenization ─────────────────────────────────────────────

/** Common English stopwords and noise terms — kept out of the vocabulary
 *  table so fuzzy correction does not snap rare typos to "the" or "fix". */
const STOPWORDS = new Set<string>([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

/** FTS5 operators we strip from queries to avoid syntax errors. */
const FTS5_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

/**
 * Split a user query into FTS5-safe tokens.
 *
 * - Unicode-letters, digits, and underscore are token chars (so snake_case
 *   stays joined for trigram matching — the porter tokenizer will resplit
 *   on underscore at index-time, which is what we want).
 * - Bare FTS5 operators (`AND`, `OR`, `NOT`, `NEAR`) are dropped.
 * - Returns lowercase tokens with no quoting; caller picks AND/OR shape.
 */
function tokenizeQuery(query: string): string[] {
  return query
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FTS5_OPERATORS.has(w.toUpperCase()))
    .map((w) => w.toLowerCase());
}

/** Build an FTS5 OR query: each token quoted and joined by " OR ". */
function buildOrQuery(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).filter((t) => t !== `""`).join(" OR ");
}

/** Words ≥3 chars, stopword-filtered, lowercased — used for the vocab table. */
function extractVocabWords(text: string): Set<string> {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return seen;
}

// ── Fuzzy correction ─────────────────────────────────────────

/** Edit-distance budget by word length — short words tolerate fewer typos. */
function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

// ── Reciprocal Rank Fusion (Cormack et al. 2009) ────────────

/**
 * Fuse two BM25-ranked result lists into one ranking. Standard RRF with
 * K = 60: each result contributes 1/(K + rank) to its chunk-id key,
 * top-`limit` survives, lower RRF score becomes a more negative `score`
 * for downstream ORDER-BY-`score` ascending callers (e.g. tests).
 */
function rrfFuse(
  porter: RankedSearchResult[],
  trigram: RankedSearchResult[],
  limit: number,
  layer: SearchMatchLayer,
): SearchResult[] {
  const K = 60;
  const scoreMap = new Map<number, { result: RankedSearchResult; score: number }>();
  const key = (r: RankedSearchResult) => r.chunkId;

  for (let i = 0; i < porter.length; i++) {
    const r = porter[i];
    const k = key(r);
    const existing = scoreMap.get(k);
    const contribution = 1 / (K + i + 1);
    if (existing) existing.score += contribution;
    else scoreMap.set(k, { result: r, score: contribution });
  }
  for (let i = 0; i < trigram.length; i++) {
    const r = trigram[i];
    const k = key(r);
    const existing = scoreMap.get(k);
    const contribution = 1 / (K + i + 1);
    if (existing) existing.score += contribution;
    else scoreMap.set(k, { result: r, score: contribution });
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => {
      const { chunkId: _chunkId, ...publicResult } = result;
      return { ...publicResult, score: -score, matchLayer: layer };
    });
}

// ── Proximity reranking ─────────────────────────────────────

function findAllPositions(text: string, term: string): number[] {
  if (!term) return [];
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Find the minimum span (window size in chars) covering one position from
 * each list. Sweep-line: advance the pointer at the current minimum.
 */
function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists.map((p) => [...p].sort((a, b) => a - b));
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;
    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) { curMin = val; minIdx = i; }
      if (val > curMax) curMax = val;
    }
    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;
    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

/**
 * For multi-term queries, rerank fused results so that rows where the terms
 * appear close together (small min-span) float to the top. Single-term
 * queries are returned untouched.
 */
function applyProximityReranking(results: SearchResult[], tokens: string[]): SearchResult[] {
  const terms = tokens.filter((t) => t.length >= 2);
  if (terms.length < 2) return results;

  return results
    .map((r) => {
      const haystack = r.body.toLowerCase();
      const positions = terms.map((t) => findAllPositions(haystack, t));
      if (positions.some((p) => p.length === 0)) {
        return { result: r, boost: 0 };
      }
      const minSpan = findMinSpan(positions);
      const boost = 1 / (1 + minSpan / Math.max(haystack.length, 1));
      return { result: r, boost };
    })
    .sort((a, b) => b.boost - a.boost || a.result.score - b.result.score)
    .map(({ result }) => result);
}
