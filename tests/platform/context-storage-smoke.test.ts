import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CacheStore } from "../../src/context-mode/cache-store.js";
import { EventStore, PRIORITY } from "../../src/context-mode/event-store.js";
import { KnowledgeStore } from "../../src/context-mode/knowledge/store.js";
import { MemoryStore } from "../../src/context-mode/memory-store.js";
import { MetricsStore } from "../../src/context-mode/metrics-store.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-platform-storage-"));
});

afterEach(() => {
  rmDirWithRetry(tmpDir);
});

describe("context-mode storage portability", () => {
  test("SQLite-backed stores initialize and perform one durable operation", async () => {
    const eventStore = new EventStore(path.join(tmpDir, "events.db"));
    eventStore.init();
    try {
      eventStore.writeEvent({
        sessionId: "session-1",
        category: "file",
        data: "{\"path\":\"README.md\"}",
        priority: PRIORITY.medium,
        source: "tool_result",
        timestamp: 1,
      });
      expect(eventStore.searchEvents("session-1", "README")).toHaveLength(1);
    } finally {
      eventStore.close();
    }

    const metricsStore = new MetricsStore({ dbPath: path.join(tmpDir, "metrics.db"), projectSlug: "demo" });
    metricsStore.init();
    try {
      metricsStore.upsertSession({ session_id: "session-1", cwd: tmpDir, ts: 1 });
      metricsStore.record({
        session_id: "session-1",
        ts: 1,
        layer: "L2",
        tool: "read",
        processor: "read",
        before_bytes: 100,
        after_bytes: 40,
        cache_hit: 0,
        unique_source_hash: "hash",
        context_tokens: null,
        context_window: null,
        context_percent: null,
      });
      await metricsStore.flushPendingForTest();
      expect(metricsStore.getSessionTotals("session-1")).toMatchObject({ rowCount: 1, saved: 60 });
    } finally {
      metricsStore.close();
    }

    const cacheStore = new CacheStore({
      dbPath: path.join(tmpDir, "cache.db"),
      payloadRoot: path.join(tmpDir, "cache-payloads"),
      projectSlug: "demo",
    });
    cacheStore.init();
    try {
      const cached = cacheStore.putText({ sessionId: "session-1", text: "portable cache payload", sourceTool: "read" });
      const opened = cacheStore.openText(cached.handle);
      expect(opened.ok ? opened.text : "").toBe("portable cache payload");
    } finally {
      cacheStore.close();
    }

    const memoryStore = new MemoryStore({ dbPath: path.join(tmpDir, "memory.db"), projectSlug: "demo" });
    memoryStore.init();
    try {
      memoryStore.put({ ownerScope: "project", type: "decision", body: "Keep Windows portability smoke coverage", now: 1 });
      expect(memoryStore.retrieve({ sessionId: "session-1" }).map((row) => row.body)).toContain("Keep Windows portability smoke coverage");
    } finally {
      memoryStore.close();
    }

    const knowledgeStore = new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
    knowledgeStore.init();
    try {
      knowledgeStore.index([
        {
          title: "Windows storage",
          body: "SQLite smoke coverage stays fast",
          contentType: "prose",
          source: "doc.md",
        },
      ], "doc.md");
      expect(knowledgeStore.search(["sqlite"], { limit: 1 })[0]?.results[0]?.source).toBe("doc.md");
    } finally {
      knowledgeStore.close();
    }
  });
});
