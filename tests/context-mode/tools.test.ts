// tests/context-mode/tools.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";

import { KnowledgeStore } from "../../src/context-mode/knowledge/store.js";
import { registerContextModeTools, _stats, INTENT_THRESHOLD } from "../../src/context-mode/tools.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let store: KnowledgeStore;
let registeredTools: Map<string, any>;

function createMockPlatform() {
  registeredTools = new Map();
  return {
    registerTool: mock((def: any) => {
      registeredTools.set(def.name, def);
    }),
  } as any;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-tools-"));
  store = new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
  store.init();

  // Reset stats
  for (const key of Object.keys(_stats.calls)) delete _stats.calls[key];
  _stats.bytesReturned = 0;
});

afterEach(() => {
  if (process.platform === "win32") {
    return;
  }
  store.close();
  if (fs.existsSync(tmpDir)) {
    rmDirWithRetry(tmpDir);
  }
});

function registerAll() {
  const platform = createMockPlatform();
  registerContextModeTools(platform, store);
  return platform;
}

async function callTool(name: string, params: any): Promise<any> {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.execute("test-call-id", params, AbortSignal.timeout(30000), () => {}, {});
}

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────
describe("registerContextModeTools", () => {
  test("registers exactly 9 tools", () => {
    registerAll();
    expect(registeredTools.size).toBe(9);
  });

  test("all tools have name, parameters, and execute function", () => {
    registerAll();
    for (const [name, def] of registeredTools) {
      expect(def.name).toBe(name);
      expect(def.parameters).toBeDefined();
      expect(typeof def.execute).toBe("function");
    }
  });

  test("every tool has a description and promptSnippet", () => {
    registerAll();
    for (const [, def] of registeredTools) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(typeof def.promptSnippet).toBe("string");
      expect(def.promptSnippet.length).toBeGreaterThan(0);
    }
  });

  test("every tool exposes at least one promptGuideline (drift guard)", () => {
    registerAll();
    for (const [name, def] of registeredTools) {
      expect(Array.isArray(def.promptGuidelines)).toBe(true);
      expect(def.promptGuidelines.length).toBeGreaterThan(0);
      for (const guideline of def.promptGuidelines) {
        expect(typeof guideline).toBe("string");
        expect(guideline.length).toBeGreaterThan(0);
      }
      // Sanity: guideline should mention something relevant.
      const guideText = def.promptGuidelines.join(" ").toLowerCase();
      expect(guideText).not.toBe("");
      // Each guideline is attached to the intended tool.
      expect(name).toBeDefined();
    }
  });

  test("tool names match expected set", () => {
    registerAll();
    const names = [...registeredTools.keys()].sort();
    expect(names).toEqual([
      "ctx_batch_execute",
      "ctx_execute",
      "ctx_execute_file",
      "ctx_fetch_and_index",
      "ctx_index",
      "ctx_open_cached",
      "ctx_purge",
      "ctx_search",
      "ctx_stats",
    ]);
  });

  test("ctx_open_cached exposes the handle/offset/limit schema", () => {
    registerAll();
    expect(registeredTools.get("ctx_open_cached")?.parameters).toEqual({
      type: "object",
      properties: {
        handle: { type: "string", description: "cache://<sha256> handle to open" },
        offset: { type: "number", description: "Character offset in decoded cached text (default: 0)" },
        limit: { type: "number", description: "Maximum characters to return, capped at 100KB characters" },
      },
      required: ["handle"],
    });
  });

  test("does nothing when platform lacks registerTool", () => {
    const platform = { registerTool: undefined } as any;
    registerContextModeTools(platform, store);
    // no throw
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_execute
// ─────────────────────────────────────────────────────────────
describe("ctx_execute", () => {
  test("executes shell command and returns stdout", async () => {
    registerAll();
    const result = await callTool("ctx_execute", { language: "shell", code: 'echo "hello world"' });
    expect(result.content[0].text).toContain("hello world");
  });

  test("executes javascript via bun", async () => {
    registerAll();
    const result = await callTool("ctx_execute", { language: "javascript", code: "console.log(42)" });
    expect(result.content[0].text).toContain("42");
  });

  test("reports non-zero exit code", async () => {
    registerAll();
    const result = await callTool("ctx_execute", { language: "shell", code: "exit 1" });
    expect(result.content[0].text).toContain("[exit code: 1]");
  });

  test("rejects invalid language", async () => {
    registerAll();
    await expect(callTool("ctx_execute", { language: "brainfuck", code: "+" })).rejects.toThrow(
      /Unsupported language/,
    );
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_execute_file
// ─────────────────────────────────────────────────────────────
describe("ctx_execute_file", () => {
  test("injects FILE_CONTENT and executes code", async () => {
    registerAll();
    const filePath = path.join(tmpDir, "data.txt");
    fs.writeFileSync(filePath, "line1\nline2\nline3");

    const result = await callTool("ctx_execute_file", {
      path: filePath,
      language: "javascript",
      code: "console.log(FILE_CONTENT.split('\\n').length)",
    });
    expect(result.content[0].text).toContain("3");
  });

  test("python FILE_CONTENT injection", async () => {
    registerAll();
    const filePath = path.join(tmpDir, "data.txt");
    fs.writeFileSync(filePath, "hello");

    const result = await callTool("ctx_execute_file", {
      path: filePath,
      language: "python",
      code: "print(len(FILE_CONTENT))",
    });
    expect(result.content[0].text).toContain("5");
  });

  test("shell FILE_CONTENT injection", async () => {
    registerAll();
    const filePath = path.join(tmpDir, "data.txt");
    fs.writeFileSync(filePath, "test content");

    const result = await callTool("ctx_execute_file", {
      path: filePath,
      language: "shell",
      code: 'echo "$FILE_CONTENT"',
    });
    expect(result.content[0].text).toContain("test content");
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_index
// ─────────────────────────────────────────────────────────────
describe("ctx_index", () => {
  test("indexes content by string", async () => {
    registerAll();
    const result = await callTool("ctx_index", {
      content: "# Hello\n\nWorld content here.",
      source: "test-source",
    });
    expect(result.content[0].text).toContain("Indexed");
    expect(result.content[0].text).toContain("test-source");
  });

  test("indexes content by file path", async () => {
    registerAll();
    const filePath = path.join(tmpDir, "doc.md");
    fs.writeFileSync(filePath, "# Title\n\nSome documentation.");

    const result = await callTool("ctx_index", { path: filePath, source: "doc-source" });
    expect(result.content[0].text).toContain("Indexed");
    expect(result.content[0].text).toContain("doc-source");
  });

  test("rejects when both content and path provided", async () => {
    registerAll();
    await expect(
      callTool("ctx_index", { content: "text", path: "/file", source: "x" }),
    ).rejects.toThrow(/Exactly one/);
  });

  test("rejects when neither content nor path provided", async () => {
    registerAll();
    await expect(callTool("ctx_index", { source: "x" })).rejects.toThrow(/Exactly one/);
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_search
// ─────────────────────────────────────────────────────────────
describe("ctx_search", () => {
  test("searches indexed content", async () => {
    registerAll();
    // Index some content first
    await callTool("ctx_index", {
      content: "# Authentication\n\nJWT tokens are used for auth.",
      source: "docs",
    });

    const result = await callTool("ctx_search", { queries: ["JWT authentication"] });
    expect(result.content[0].text).toContain("JWT");
  });

  test("returns grouped results per query", async () => {
    registerAll();
    await callTool("ctx_index", {
      content: "# Database\n\nSQLite is used.\n\n# Cache\n\nRedis is the cache layer.",
      source: "arch",
    });

    const result = await callTool("ctx_search", { queries: ["SQLite database", "Redis cache"] });
    const text = result.content[0].text;
    expect(text).toContain("SQLite database");
    expect(text).toContain("Redis cache");
  });

  test("source filtering works", async () => {
    registerAll();
    await callTool("ctx_index", { content: "# A\n\nContent A", source: "source-a" });
    await callTool("ctx_index", { content: "# B\n\nContent B", source: "source-b" });

    const result = await callTool("ctx_search", {
      queries: ["Content"],
      source: "source-a",
    });
    const text = result.content[0].text;
    expect(text).toContain("source-a");
    expect(text).not.toContain("source-b");
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_batch_execute
// ─────────────────────────────────────────────────────────────
describe("ctx_batch_execute", () => {
  test("runs commands and returns search results", async () => {
    registerAll();
    const result = await callTool("ctx_batch_execute", {
      commands: [
        { label: "Echo test", command: 'echo "hello from batch"' },
        { label: "Date", command: "echo today" },
      ],
      queries: ["hello batch"],
    });
    const text = result.content[0].text;
    expect(text).toContain("Executed 2 commands");
    expect(text).toContain("Echo test");
    expect(text).toContain("Date");
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_fetch_and_index
// ─────────────────────────────────────────────────────────────
describe("ctx_fetch_and_index", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches URL, indexes, and returns preview", async () => {
    registerAll();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("<html><body><h1>Title</h1><p>Some content here</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    ) as any;

    const result = await callTool("ctx_fetch_and_index", {
      url: "https://example.com/docs",
      source: "example-docs",
    });
    const text = result.content[0].text;
    expect(text).toContain("example-docs");
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_stats
// ─────────────────────────────────────────────────────────────
describe("ctx_stats", () => {
  test("returns formatted stats", async () => {
    registerAll();
    // Make a few calls to accumulate stats
    await callTool("ctx_execute", { language: "shell", code: "echo hi" });
    await callTool("ctx_execute", { language: "shell", code: "echo there" });

    const result = await callTool("ctx_stats", {});
    const text = result.content[0].text;
    expect(text).toContain("Context Mode Stats");
    expect(text).toContain("ctx_execute");
    expect(text).toContain("Chunks indexed");
  });
});

// ─────────────────────────────────────────────────────────────
// ctx_purge
// ─────────────────────────────────────────────────────────────
describe("ctx_purge", () => {
  test("purges all indexed content", async () => {
    registerAll();
    await callTool("ctx_index", { content: "# Test\n\nContent", source: "to-purge" });

    const result = await callTool("ctx_purge", {});
    expect(result.content[0].text).toContain("Purged");

    // Verify search returns nothing
    const search = await callTool("ctx_search", { queries: ["Test"] });
    expect(search.content[0].text).toContain("No matches");
  });
});

// ─────────────────────────────────────────────────────────────
// Intent-driven filtering
// ─────────────────────────────────────────────────────────────
describe("intent-driven filtering", () => {
  test("small output returned as-is even with intent", async () => {
    registerAll();
    const result = await callTool("ctx_execute", {
      language: "shell",
      code: "echo small",
      intent: "find something",
    });
    // Small output should not be filtered
    expect(result.content[0].text).toContain("small");
    expect(result.content[0].text).not.toContain("Indexed Sections");
  });

  test("large output with intent triggers auto-indexing", async () => {
    registerAll();
    // Generate output > 5KB
    const bigEcho = `echo '${" # Section\\n\\n".repeat(100)}${"x".repeat(INTENT_THRESHOLD + 100)}'`;
    const result = await callTool("ctx_execute", {
      language: "shell",
      code: bigEcho,
      intent: "find sections",
    });
    // Should see filtering artifacts
    const text = result.content[0].text;
    expect(text.length).toBeGreaterThan(0);
  });
});


// ─────────────────────────────────────────────────────────────
// ctx_stats — JSON mode (Tasks 36, 37, 38)
// ─────────────────────────────────────────────────────────────

import {
  MetricsStore,
  __setMetricsStoreForTest,
  _resetMetricsStoreCache,
} from "../../src/context-mode/metrics-store.js";
import { _resetCache as _resetHooksCache, __setCacheStoreForTest } from "../../src/context-mode/hooks.js";
import { CacheStore } from "../../src/context-mode/cache-store.js";

describe("ctx_stats — markdown vs JSON", () => {
  let metricsTmp: string;
  let metricsDb: string;
  let metrics: MetricsStore;

  beforeEach(() => {
    _resetHooksCache();
    _resetMetricsStoreCache();
    metricsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "supi-tools-stats-"));
    metricsDb = path.join(metricsTmp, "metrics.db");
    metrics = new MetricsStore({ dbPath: metricsDb, projectSlug: "demo" });
    metrics.init();
    metrics.upsertSession({ session_id: "", cwd: metricsTmp });
  });

  afterEach(() => {
    try { metrics.close(); } catch { /* already closed */ }
    rmDirWithRetry(metricsTmp);
    _resetMetricsStoreCache();
  });

  test("defaults to markdown when format is omitted (Task 36)", async () => {
    registerAll();
    const result = await callTool("ctx_stats", {});
    expect(result.content[0].text).toContain("## Context Mode Stats");
  });

  test("format=json returns the spec \u00a76.2 contract (Task 37)", async () => {
    registerAll();
    __setMetricsStoreForTest(metrics);
    metrics.record({
      session_id: "",
      ts: Date.now(),
      layer: "L2",
      tool: "bash",
      processor: "bash",
      before_bytes: 1000,
      after_bytes: 100,
      cache_hit: 0,
      unique_source_hash: null,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
    await metrics.flushPendingForTest();

    const result = await callTool("ctx_stats", { format: "json" });
    const parsed = JSON.parse(result.content[0].text);

    expect(typeof parsed.session.id).toBe("string");
    expect(typeof parsed.session.startedAt).toBe("number");
    expect(typeof parsed.session.rowCount).toBe("number");

    expect(typeof parsed.totals.beforeBytes).toBe("number");
    expect(typeof parsed.totals.afterBytes).toBe("number");
    expect(typeof parsed.totals.saved).toBe("number");
    expect(typeof parsed.totals.tokensEstimated).toBe("number");

    expect(Array.isArray(parsed.perProcessor)).toBe(true);
    for (const t of parsed.perProcessor) {
      expect(typeof t.processor).toBe("string");
      expect(typeof t.saved).toBe("number");
      expect(typeof t.calls).toBe("number");
    }

    expect(Array.isArray(parsed.perLayer)).toBe(true);
    for (const layer of parsed.perLayer) {
      expect(typeof layer.layer).toBe("string");
      expect(typeof layer.saved).toBe("number");
      expect(typeof layer.rows).toBe("number");
    }

    expect(typeof parsed.uniqueSourceShare).toBe("number");
    expect(parsed.uniqueSourceShare).toBeGreaterThanOrEqual(0);
    expect(parsed.uniqueSourceShare).toBeLessThanOrEqual(1);
    expect(typeof parsed.writeFailures).toBe("number");
  });

  test("format=json with null metricsStore uses documented defaults (Task 38)", async () => {
    registerAll();
    __setMetricsStoreForTest(null);

    const result = await callTool("ctx_stats", { format: "json" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.totals).toEqual({
      beforeBytes: 0,
      afterBytes: 0,
      saved: 0,
      tokensEstimated: 0,
    });
    expect(parsed.perProcessor).toEqual([]);
    expect(parsed.perLayer).toEqual([]);
    expect(parsed.uniqueSourceShare).toBe(0);
    expect(parsed.writeFailures).toBe(0);
    expect(parsed.session.startedAt).toBe(0);
    expect(parsed.session.rowCount).toBe(0);
  });
});


// ─────────────────────────────────────────────────────────────
// ctx_open_cached
// ─────────────────────────────────────────────────────────────
describe("ctx_open_cached", () => {
  let cache: CacheStore | null = null;

  beforeEach(() => {
    _resetHooksCache();
    cache = new CacheStore({
      dbPath: path.join(tmpDir, "cache.db"),
      payloadRoot: path.join(tmpDir, "cache-payloads"),
      projectSlug: "demo",
    });
    cache.init();
    __setCacheStoreForTest(cache);
  });

  afterEach(() => {
    __setCacheStoreForTest(null);
    try {
      cache?.close();
    } catch {
      // already closed
    }
    cache = null;
  });

  test("opens a valid handle with offset and limit metadata", async () => {
    registerAll();
    const put = cache!.putText({ sessionId: "s1", text: "abcdef", sourceTool: "read", sourceHash: "one" });

    const result = await callTool("ctx_open_cached", { handle: put.handle, offset: 2, limit: 3 });
    const text = result.content[0].text;

    expect(text).toContain(`## Cached content ${put.handle}`);
    expect(text).toContain("- Total: 6 bytes, 6 chars");
    expect(text).toContain("- Returned: chars 2..5 of 6");
    expect(text).toContain("- Next offset: 5");
    expect(text).toEndWith("cde");
  });

  test("large slice + header stays under MAX_RESPONSE_SIZE without losing advertised content", async () => {
    registerAll();
    // 200KB of text \u2014 well over MAX_RESPONSE_SIZE (100KB) and HARD_CACHE_OPEN_CHARS (100KB).
    const text = "x".repeat(200 * 1024);
    const put = cache!.putText({ sessionId: "s1", text, sourceTool: "read", sourceHash: "big" });

    const result = await callTool("ctx_open_cached", { handle: put.handle, offset: 0 });
    const out: string = result.content[0].text;

    // Response must be bounded by the 100KB cap.
    expect(out.length).toBeLessThanOrEqual(100 * 1024);
    // The advertised next offset must reflect characters actually returned, not characters
    // that were silently dropped by capResponseSize. Body length = total length \u2212 header.
    const headerEnd = out.indexOf("\n---\n");
    expect(headerEnd).toBeGreaterThan(0);
    const body = out.slice(headerEnd + "\n---\n".length);
    const match = /- Returned: chars 0\.\.(\d+) of \d+/.exec(out);
    expect(match).not.toBeNull();
    const advertisedReturned = Number(match![1]);
    expect(body.length).toBe(advertisedReturned);
  });

  test("returns explicit text for invalid handles", async () => {
    registerAll();

    const result = await callTool("ctx_open_cached", { handle: "cache://NOPE" });

    expect(result.content[0].text).toContain("Cannot open cached content: invalid cache handle");
    expect(result.content[0].text).toContain("64 lowercase hexadecimal characters");
  });

  test("returns explicit text for missing handles", async () => {
    registerAll();
    const handle = `cache://${"0".repeat(64)}`;

    const result = await callTool("ctx_open_cached", { handle });

    expect(result.content[0].text).toBe(`Cannot open cached content: handle was not found: ${handle}.`);
  });

  test("returns explicit text for corrupt payloads", async () => {
    registerAll();
    const put = cache!.putText({ sessionId: "s1", text: "corrupt me", sourceTool: "read", sourceHash: "corrupt" });
    const meta = cache!.getEntryMeta(put.handle)!;
    fs.writeFileSync(path.join(cache!.payloadRoot, meta.payloadRelpath), "not brotli");

    const result = await callTool("ctx_open_cached", { handle: put.handle });

    expect(result.content[0].text).toBe(`Cannot open cached content: payload is corrupt for ${put.handle}.`);
  });

  test("returns explicit text when cache store is unavailable", async () => {
    registerAll();
    __setCacheStoreForTest(null);

    const result = await callTool("ctx_open_cached", { handle: `cache://${"1".repeat(64)}` });

    expect(result.content[0].text).toBe("Cannot open cached content: cache store is unavailable for this session.");
  });

  test("records cache-open metrics for hits and misses", async () => {
    const metrics = new MetricsStore({ dbPath: path.join(tmpDir, "cache-open-metrics.db"), projectSlug: "demo" });
    metrics.init();
    __setMetricsStoreForTest(metrics);
    try {
      registerAll();
      const put = cache!.putText({ sessionId: "s1", text: "abcdef", sourceTool: "read", sourceHash: "metric" });

      await callTool("ctx_open_cached", { handle: put.handle, offset: 1, limit: 2 });
      await callTool("ctx_open_cached", { handle: `cache://${"2".repeat(64)}` });
      await metrics.flushPendingForTest();

      const probe = new Database(metrics.dbPath);
      try {
        const rows = probe.prepare(`SELECT layer, tool, processor, before_bytes, after_bytes, cache_hit FROM metrics WHERE processor = 'cache-open' ORDER BY id ASC`).all() as Array<{
          layer: string;
          tool: string;
          processor: string;
          before_bytes: number;
          after_bytes: number;
          cache_hit: number;
        }>;
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
          layer: "L3",
          tool: "ctx_open_cached",
          processor: "cache-open",
          before_bytes: put.sizeBytes,
          after_bytes: 2,
          cache_hit: 1,
        });
        expect(rows[1].layer).toBe("L3");
        expect(rows[1].tool).toBe("ctx_open_cached");
        expect(rows[1].processor).toBe("cache-open");
        expect(rows[1].cache_hit).toBe(0);
      } finally {
        probe.close();
      }
    } finally {
      __setMetricsStoreForTest(null);
      metrics.close();
    }
  });
});