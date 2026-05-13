import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Chunk } from "../../../src/context-mode/knowledge/chunker.js";
import { KnowledgeStore } from "../../../src/context-mode/knowledge/store.js";
import { rmDirWithRetry } from "../../helpers/fs.js";

function makeChunk(
  title: string,
  body: string,
  opts?: { contentType?: "code" | "prose"; source?: string },
): Chunk {
  return {
    title,
    body,
    contentType: opts?.contentType ?? "prose",
    source: opts?.source ?? "test",
  };
}

function expectCleanupAttempted(dir: string): void {
  expect(() => rmDirWithRetry(dir)).not.toThrow();
  if (process.platform !== "win32") {
    expect(fs.existsSync(dir)).toBe(false);
  }
}


describe("KnowledgeStore", () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-store-"));
    store = new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
    store.init();
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) {
      rmDirWithRetry(tmpDir);
    }
  });

  test("index + search round-trip", () => {
    const chunks = [
      makeChunk("Setup Guide", "Install bun globally using npm"),
      makeChunk("API Reference", "The fetch function returns a promise"),
    ];
    store.index(chunks, "test");

    const results = store.search(["install bun"]);
    expect(results).toHaveLength(1);
    expect(results[0].query).toBe("install bun");
    expect(results[0].results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].results[0].source).toBe("test");
    expect(results[0].results[0].body).toContain("Install bun");
  });

  test("BM25 ranking: title match ranks higher", () => {
    const chunks = [
      makeChunk("Unrelated Title", "bun is a JavaScript runtime for building applications"),
      makeChunk("Bun Runtime", "A fast all-in-one toolkit"),
    ];
    store.index(chunks, "test");

    const results = store.search(["bun"]);
    expect(results[0].results.length).toBe(2);
    // Title weight is 5.0 vs body weight 1.0, so title match should rank first
    expect(results[0].results[0].title).toBe("Bun Runtime");
  });

  test("source filtering", () => {
    store.index([makeChunk("Alpha", "content about alpha topic")], "src-a");
    store.index([makeChunk("Beta", "content about beta topic")], "src-b");

    const results = store.search(["content"], { source: "src-a" });
    expect(results[0].results).toHaveLength(1);
    expect(results[0].results[0].source).toBe("src-a");
  });

  test("content type filtering", () => {
    store.index(
      [
        makeChunk("Code Example", "function hello() { return 1; }", { contentType: "code" }),
        makeChunk("Prose Example", "This is a description of the function", {
          contentType: "prose",
        }),
      ],
      "test",
    );

    const results = store.search(["function"], { contentType: "code" });
    expect(results[0].results).toHaveLength(1);
    expect(results[0].results[0].contentType).toBe("code");
  });

  test("replace semantics: re-index same source replaces old content", () => {
    store.index([makeChunk("Old", "deprecated legacy content")], "replaceable");
    store.index([makeChunk("New", "fresh modern content")], "replaceable");

    const oldResults = store.search(["deprecated legacy"]);
    expect(oldResults[0].results).toHaveLength(0);

    const newResults = store.search(["fresh modern"]);
    expect(newResults[0].results).toHaveLength(1);
    expect(newResults[0].results[0].title).toBe("New");
  });

  test("project re-index removes migrated legacy rows for the same source", () => {
    const db = (store as any).db;
    db.prepare(
      `INSERT INTO content_chunks (source, title, body, content_type, owner_scope, owner_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("replaceable", "Legacy", "deprecated legacy content", "prose", "legacy", "");

    store.index([makeChunk("New", "fresh modern content")], "replaceable");

    expect(store.search(["deprecated legacy"], { limit: 10 })[0].results).toHaveLength(0);
    const newResults = store.search(["fresh modern"], { limit: 10 });
    expect(newResults[0].results).toHaveLength(1);
    expect(newResults[0].results[0].title).toBe("New");
  });

  test("session ownership replaces only matching source owner", () => {
    store.index([makeChunk("Active", "active session secret")], "shared", {
      ownerScope: "session",
      ownerId: "active-session",
    });
    store.index([makeChunk("Other", "other session secret")], "shared", {
      ownerScope: "session",
      ownerId: "other-session",
    });
    store.index([makeChunk("Project", "project shared knowledge")], "shared", {
      ownerScope: "project",
    });

    store.index([makeChunk("Active New", "fresh active session secret")], "shared", {
      ownerScope: "session",
      ownerId: "active-session",
    });

    const activeResults = store.search(["secret"], {
      owner: { ownerScope: "session", ownerId: "active-session" },
      limit: 10,
    });
    expect(activeResults[0].results.map((r) => r.title).sort()).toEqual(["Active New"]);

    const allResults = store.search(["secret"], { includeAllSessions: true, limit: 10 });
    expect(allResults[0].results.map((r) => r.title).sort()).toEqual(["Active New", "Other"]);
  });

  test("default search excludes other session-owned rows", () => {
    store.index([makeChunk("Active", "visible active content")], "owned", {
      ownerScope: "session",
      ownerId: "active-session",
    });
    store.index([makeChunk("Other", "hidden other content")], "owned", {
      ownerScope: "session",
      ownerId: "other-session",
    });
    store.index([makeChunk("Project", "visible project content")], "owned", {
      ownerScope: "project",
    });

    const activeResults = store.search(["content"], {
      owner: { ownerScope: "session", ownerId: "active-session" },
      limit: 10,
    });
    expect(activeResults[0].results.map((r) => r.title).sort()).toEqual(["Active", "Project"]);

    const defaultResults = store.search(["content"], { limit: 10 });
    expect(defaultResults[0].results.map((r) => r.title)).toEqual(["Project"]);
  });

  test("clearSession deletes only active-session chunks and URL cache rows", () => {
    store.index([makeChunk("Active", "active clearable content")], "clear", {
      ownerScope: "session",
      ownerId: "active-session",
    });
    store.index([makeChunk("Other", "other retained content")], "clear", {
      ownerScope: "session",
      ownerId: "other-session",
    });
    const now = Math.floor(Date.now() / 1000);
    const db = (store as any).db;
    db.prepare("INSERT INTO url_cache (url, source, owner_scope, owner_id, fetched_at) VALUES (?, ?, ?, ?, ?)").run(
      "https://active.example.com",
      "clear",
      "session",
      "active-session",
      now,
    );
    db.prepare("INSERT INTO url_cache (url, source, owner_scope, owner_id, fetched_at) VALUES (?, ?, ?, ?, ?)").run(
      "https://other.example.com",
      "clear",
      "session",
      "other-session",
      now,
    );

    expect(store.clearSession("active-session")).toEqual({ chunksDeleted: 1, urlCacheDeleted: 1 });

    const activeResults = store.search(["active"], {
      owner: { ownerScope: "session", ownerId: "active-session" },
    });
    expect(activeResults[0].results).toHaveLength(0);

    const otherResults = store.search(["other"], {
      owner: { ownerScope: "session", ownerId: "other-session" },
    });
    expect(otherResults[0].results).toHaveLength(1);
    const remainingUrls = db.prepare("SELECT url FROM url_cache ORDER BY url").all() as Array<{ url: string }>;
    expect(remainingUrls.map((row) => row.url)).toEqual(["https://other.example.com"]);
  });

  test("listSessions includes session-owned chunks and URL cache rows", () => {
    store.index([makeChunk("Active", "active listable content")], "list", {
      ownerScope: "session",
      ownerId: "active-session",
    });
    store.index([makeChunk("Other", "other listable content")], "list", {
      ownerScope: "session",
      ownerId: "other-session",
    });
    const db = (store as any).db;
    db.prepare("INSERT INTO url_cache (url, source, owner_scope, owner_id, fetched_at) VALUES (?, ?, ?, ?, ?)").run(
      "https://active.example.com",
      "list",
      "session",
      "active-session",
      Math.floor(Date.now() / 1000),
    );

    expect(store.listSessions()).toEqual([
      { session_id: "active-session", chunk_count: 1, url_cache_count: 1 },
      { session_id: "other-session", chunk_count: 1, url_cache_count: 0 },
    ]);
  });

  test("per-query grouping with multiple queries", () => {
    store.index(
      [
        makeChunk("Dogs", "canine companions are loyal"),
        makeChunk("Cats", "feline friends are independent"),
      ],
      "test",
    );

    const results = store.search(["canine", "feline"]);
    expect(results).toHaveLength(2);
    expect(results[0].query).toBe("canine");
    expect(results[0].results.length).toBeGreaterThanOrEqual(1);
    expect(results[1].query).toBe("feline");
    expect(results[1].results.length).toBeGreaterThanOrEqual(1);
  });

  test("purge returns count and empties store", () => {
    store.index(
      [makeChunk("A", "first chunk"), makeChunk("B", "second chunk")],
      "test",
    );

    const purged = store.purge();
    expect(purged).toBe(2);

    const results = store.search(["chunk"]);
    expect(results[0].results).toHaveLength(0);
  });

  test("purge on empty store returns 0", () => {
    expect(store.purge()).toBe(0);
  });

  test("getStats returns correct values", () => {
    store.index([makeChunk("X", "data one")], "source-1");
    store.index([makeChunk("Y", "data two")], "source-2");

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(2);
    expect(stats.sources).toEqual(["source-1", "source-2"]);
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  test("getStats on empty store", () => {
    const stats = store.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.sources).toEqual([]);
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  test("schema includes owner-scope indexes for cleanup and replacement", () => {
    const db = (store as any).db;
    const contentIndexes = (db.prepare("PRAGMA index_list(content_chunks)").all() as Array<{ name: string }>).map((row) => row.name);
    const urlIndexes = (db.prepare("PRAGMA index_list(url_cache)").all() as Array<{ name: string }>).map((row) => row.name);

    expect(contentIndexes).toContain("idx_content_chunks_owner");
    expect(contentIndexes).toContain("idx_content_chunks_source_owner");
    expect(urlIndexes).toContain("idx_url_cache_owner");
  });

  test("pruneExpiredUrls removes old entries", () => {
    const db = (store as any).db;
    const now = Math.floor(Date.now() / 1000);
    const old = now - 25 * 3600; // 25 hours ago
    db.prepare("INSERT INTO url_cache (url, source, fetched_at) VALUES (?, ?, ?)").run(
      "https://old.example.com",
      "old-src",
      old,
    );
    db.prepare("INSERT INTO url_cache (url, source, fetched_at) VALUES (?, ?, ?)").run(
      "https://new.example.com",
      "new-src",
      now,
    );

    const pruned = store.pruneExpiredUrls();
    expect(pruned).toBe(1);

    const remaining = db.prepare("SELECT COUNT(*) AS cnt FROM url_cache").get();
    expect(remaining.cnt).toBe(1);
  });

  test("close is idempotent and releases the database directory for cleanup", () => {
    store.index([makeChunk("Cleanup", "release file locks before teardown")], "cleanup");

    store.close();
    expect(() => store.close()).not.toThrow();

    expectCleanupAttempted(tmpDir);
  });

  test("search still works after close and reopen", () => {
    const dbPath = path.join(tmpDir, "knowledge.db");
    store.index([makeChunk("Reopen", "reopenable indexed content")], "reopen");

    store.close();
    store = new KnowledgeStore(dbPath);
    store.init();

    const results = store.search(["reopenable"]);
    expect(results[0].results).toHaveLength(1);
    expect(results[0].results[0].title).toBe("Reopen");
  });


  test("empty search returns empty results for each query", () => {
    store.index([makeChunk("Real", "actual content here")], "test");

    const results = store.search(["xyzzyplugh"]);
    expect(results).toHaveLength(1);
    expect(results[0].query).toBe("xyzzyplugh");
    expect(results[0].results).toHaveLength(0);
  });

  test("empty queries array returns empty array", () => {
    expect(store.search([])).toEqual([]);
  });

  test("limit option caps results per query", () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunk(`Item ${i}`, `searchable content number ${i}`),
    );
    store.index(chunks, "test");

    const results = store.search(["searchable content"], { limit: 1 });
    expect(results[0].results).toHaveLength(1);
  });

  test("FTS5 special characters do not crash", () => {
    store.index([makeChunk("Safe", "normal content")], "test");

    // These would be FTS5 syntax errors if not sanitized
    const results = store.search(['"unclosed quote', "col:value", "a AND OR b", "near(a,b)"]);
    expect(results).toHaveLength(4);
    // Each should return results or empty — no throw
    for (const group of results) {
      expect(Array.isArray(group.results)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Layered fallback: trigram substring, fuzzy correction, RRF, cleanup
// ─────────────────────────────────────────────────────────────────────

describe("KnowledgeStore fallback search", () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-store-fallback-"));
    store = new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
    store.init();
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) rmDirWithRetry(tmpDir);
  });

  test("trigram fallback finds an identifier fragment porter cannot", () => {
    // Porter tokenizes 'executable' / 'executor' as whole tokens; a query
    // fragment like 'execut' has no matching porter token, but trigram does.
    store.index(
      [makeChunk("Runner", "the executor coordinates background jobs")],
      "code",
    );

    const results = store.search(["execut"]);
    expect(results[0].results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].results[0].title).toBe("Runner");
    expect(results[0].results[0].matchLayer).toBe("rrf");
  });

  test("fuzzy correction recovers a typo whose trigrams miss the body", () => {
    store.index(
      [makeChunk("Quantum", "research notes on quantum entanglement and decoherence")],
      "physics",
    );

    // Body has 'quantum' (trigrams: qua, uan, ant, ntu, tum). Typo 'quontom'
    // has trigrams quo, uon, ont, nto, tom — zero overlap with the body, so
    // both porter and trigram return empty. Only fuzzy correction (snap to
    // 'quantum' via Levenshtein 2 against the vocab) can recover this.
    const results = store.search(["quontom"]);
    expect(results[0].results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].results[0].title).toBe("Quantum");
    expect(results[0].results[0].matchLayer).toBe("rrf-fuzzy");
  });

  test("RRF fuses porter and trigram into one ranked list", () => {
    store.index(
      [
        makeChunk("Both", "executor handles execution requests"),
        makeChunk("PorterOnly", "completely unrelated retrieval lexicon"),
      ],
      "mix",
    );

    const results = store.search(["executor"]);
    // 'Both' is the only doc with 'executor' — porter and trigram both rank
    // it first; RRF should keep it on top and label it as rrf.
    expect(results[0].results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].results[0].title).toBe("Both");
    expect(results[0].results[0].matchLayer).toBe("rrf");
  });

  test("RRF keeps same-title chunks distinct within one source", () => {
    store.index(
      [
        makeChunk("Repeated heading", "alpha first body"),
        makeChunk("Repeated heading", "alpha second body"),
      ],
      "same-document",
    );

    const results = store.search(["alpha"], { limit: 10 });

    expect(results[0].results.map((r) => r.body).sort()).toEqual([
      "alpha first body",
      "alpha second body",
    ]);
  });

  test("nonsense query still returns empty (no spurious fuzzy match)", () => {
    store.index([makeChunk("Real", "actual content here")], "src");
    const results = store.search(["xyzzyplugh"]);
    expect(results[0].results).toHaveLength(0);
  });

  test("source filter scopes both porter and trigram layers", () => {
    store.index([makeChunk("A", "executor coordinator service")], "src-a");
    store.index([makeChunk("B", "executor coordinator service")], "src-b");

    const onlyA = store.search(["execut"], { source: "src-a", limit: 10 });
    expect(onlyA[0].results.map((r) => r.source)).toEqual(["src-a"]);
  });

  test("contentType filter scopes both layers", () => {
    store.index(
      [
        makeChunk("Code", "fn execute() { run() }", { contentType: "code" }),
        makeChunk("Prose", "execute the plan carefully", { contentType: "prose" }),
      ],
      "mix",
    );

    const onlyCode = store.search(["execut"], { contentType: "code", limit: 10 });
    expect(onlyCode[0].results.map((r) => r.contentType)).toEqual(["code"]);
  });

  test("session ownership filter applies on the trigram fallback path", () => {
    store.index([makeChunk("Mine", "executor secret")], "shared", {
      ownerScope: "session",
      ownerId: "active",
    });
    store.index([makeChunk("Theirs", "executor secret")], "shared", {
      ownerScope: "session",
      ownerId: "other",
    });

    const mine = store.search(["execut"], {
      owner: { ownerScope: "session", ownerId: "active" },
      limit: 10,
    });
    expect(mine[0].results.map((r) => r.title)).toEqual(["Mine"]);
  });

  test("purge clears chunks, trigram, and vocabulary", () => {
    store.index([makeChunk("X", "wormhole content")], "src");
    const db = (store as any).db;

    expect((db.prepare("SELECT COUNT(*) AS c FROM content_chunks_trigram").get() as { c: number }).c).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c).toBeGreaterThan(0);

    store.purge();

    expect((db.prepare("SELECT COUNT(*) AS c FROM content_chunks_trigram").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c).toBe(0);
  });

  test("clearProject clears trigram and vocabulary", () => {
    store.index([makeChunk("X", "wormhole content")], "src");
    const db = (store as any).db;

    store.clearProject();

    expect((db.prepare("SELECT COUNT(*) AS c FROM content_chunks_trigram").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c).toBe(0);
  });

  test("clearSession leaves vocabulary intact (per-session purge only)", () => {
    store.index([makeChunk("Mine", "wormhole physics")], "src", {
      ownerScope: "session",
      ownerId: "active",
    });
    const db = (store as any).db;
    const vocabBefore = (db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c;
    expect(vocabBefore).toBeGreaterThan(0);

    store.clearSession("active");

    // Trigram is rebuilt (now empty); vocabulary survives so other sessions'
    // fuzzy correction still works.
    expect((db.prepare("SELECT COUNT(*) AS c FROM content_chunks_trigram").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c).toBe(vocabBefore);
  });

  test("re-index of same source replaces trigram rows too", () => {
    store.index([makeChunk("Old", "deprecated executor lexicon")], "same");
    store.index([makeChunk("New", "fresh runner pipeline")], "same");

    // Trigram search for the old fragment must not surface stale rows.
    const stale = store.search(["deprecat"], { limit: 10 });
    expect(stale[0].results).toHaveLength(0);

    const fresh = store.search(["pipelin"], { limit: 10 });
    expect(fresh[0].results.map((r) => r.title)).toEqual(["New"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Migration from v2 schema (no trigram, no vocabulary) to v3
// ─────────────────────────────────────────────────────────────────────

describe("KnowledgeStore v2 → v3 migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-store-migrate-"));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) rmDirWithRetry(tmpDir);
  });

  test("trigram + vocabulary are backfilled from existing v2 chunks", async () => {
    const dbPath = path.join(tmpDir, "knowledge.db");

    // Hand-build a minimal v2-shape DB: content_chunks + the single-target
    // porter-FTS table and triggers, marked user_version = 2.
    const { Database } = await import("bun:sqlite");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE content_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'prose',
        owner_scope TEXT NOT NULL DEFAULT 'project',
        owner_id TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE content_chunks_fts USING fts5(
        title, body, content='content_chunks', content_rowid='id', tokenize='porter'
      );
      CREATE TRIGGER content_chunks_ai AFTER INSERT ON content_chunks BEGIN
        INSERT INTO content_chunks_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
      CREATE TRIGGER content_chunks_ad AFTER DELETE ON content_chunks BEGIN
        INSERT INTO content_chunks_fts(content_chunks_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      END;
      INSERT INTO content_chunks (source, title, body, content_type, owner_scope, owner_id)
        VALUES ('legacy-src', 'Wormhole Notes', 'wormhole physics and entanglement', 'prose', 'legacy', '');
      PRAGMA user_version = 2;
    `);
    raw.close();

    // Now open through KnowledgeStore — should migrate to v3 and backfill.
    const store = new KnowledgeStore(dbPath);
    store.init();
    try {
      const db = (store as any).db;

      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);

      const trigramCount = (db.prepare("SELECT COUNT(*) AS c FROM content_chunks_trigram").get() as { c: number }).c;
      expect(trigramCount).toBeGreaterThan(0);

      const vocabCount = (db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c;
      expect(vocabCount).toBeGreaterThan(0);

      // The migrated row should be reachable via trigram fragment search.
      const fragment = store.search(["wormhol"], { limit: 5 });
      expect(fragment[0].results.map((r) => r.title)).toContain("Wormhole Notes");
    } finally {
      store.close();
    }
  });

  test("re-running init on a v3 store does not double-fill vocabulary", () => {
    const dbPath = path.join(tmpDir, "knowledge.db");
    const store = new KnowledgeStore(dbPath);
    store.init();
    store.index([makeChunk("Topic", "vocabulary stability check")], "src");
    const db = (store as any).db;
    const before = (db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c;
    store.close();

    const reopened = new KnowledgeStore(dbPath);
    reopened.init();
    try {
      const after = ((reopened as any).db.prepare("SELECT COUNT(*) AS c FROM vocabulary").get() as { c: number }).c;
      expect(after).toBe(before);
    } finally {
      reopened.close();
    }
  });
});