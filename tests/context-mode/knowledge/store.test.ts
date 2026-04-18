import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Chunk } from "../../../src/context-mode/knowledge/chunker.js";
import { KnowledgeStore } from "../../../src/context-mode/knowledge/store.js";

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  test("close releases WAL resources so the database directory can be removed", () => {
    store.index([makeChunk("Cleanup", "release file locks before teardown")], "cleanup");

    store.close();

    expect(() => fs.rmSync(tmpDir, { recursive: true })).not.toThrow();
    expect(fs.existsSync(tmpDir)).toBe(false);
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
