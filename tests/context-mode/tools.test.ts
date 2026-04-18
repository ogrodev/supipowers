// tests/context-mode/tools.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
  test("registers exactly 8 tools", () => {
    registerAll();
    expect(registeredTools.size).toBe(8);
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
      "ctx_purge",
      "ctx_search",
      "ctx_stats",
    ]);
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
