import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeStore } from "../../../src/context-mode/knowledge/store.js";
import { fetchAndIndex } from "../../../src/context-mode/web/fetcher.js";

let tmpDir: string;
let store: KnowledgeStore;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fetcher-"));
  store = new KnowledgeStore(path.join(tmpDir, "knowledge.db"));
  store.init();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mockFetch(body: string, contentType = "text/html", status = 200) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(body, {
        status,
        statusText: status === 200 ? "OK" : "Not Found",
        headers: { "content-type": contentType },
      }),
    ),
  ) as any;
}

const SAMPLE_HTML = `<html><body><h1>Hello</h1><p>World paragraph content here.</p></body></html>`;

describe("fetchAndIndex", () => {
  test("fresh fetch indexes HTML and returns preview", async () => {
    mockFetch(SAMPLE_HTML);

    const result = await fetchAndIndex("https://example.com/page", store);

    expect(result.cached).toBe(false);
    expect(result.source).toBe("example.com");
    expect(result.chunksIndexed).toBeGreaterThan(0);
    expect(result.preview.length).toBeGreaterThan(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("cache hit on second fetch with same URL and source", async () => {
    mockFetch(SAMPLE_HTML);

    await fetchAndIndex("https://example.com/page", store);
    const result = await fetchAndIndex("https://example.com/page", store);

    expect(result.cached).toBe(true);
    expect(result.chunksIndexed).toBeGreaterThan(0);
    expect(result.preview.length).toBeGreaterThan(0);
    // fetch called only once — second was served from cache
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("cache survives close and reopen without refetching", async () => {
    const dbPath = path.join(tmpDir, "knowledge.db");
    mockFetch(SAMPLE_HTML);

    const first = await fetchAndIndex("https://example.com/page", store);
    expect(first.cached).toBe(false);

    store.close();
    store = new KnowledgeStore(dbPath);
    store.init();

    const result = await fetchAndIndex("https://example.com/page", store);

    expect(result.cached).toBe(true);
    expect(result.chunksIndexed).toBe(first.chunksIndexed);
    expect(result.preview.length).toBeGreaterThan(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });


  test("force bypasses cache", async () => {
    mockFetch(SAMPLE_HTML);

    await fetchAndIndex("https://example.com/page", store);
    const result = await fetchAndIndex("https://example.com/page", store, {
      force: true,
    });

    expect(result.cached).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("JSON content-type is pretty-printed and indexed", async () => {
    const json = JSON.stringify({ key: "value", nested: { a: 1 } });
    mockFetch(json, "application/json");

    const result = await fetchAndIndex("https://api.example.com/data", store);

    expect(result.cached).toBe(false);
    expect(result.chunksIndexed).toBeGreaterThan(0);
    // Preview should contain the pretty-printed JSON
    expect(result.preview).toContain('"key"');
  });

  test("plain text is indexed directly", async () => {
    mockFetch("Just some plain text content.", "text/plain");

    const result = await fetchAndIndex("https://example.com/file.txt", store);

    expect(result.cached).toBe(false);
    expect(result.chunksIndexed).toBeGreaterThan(0);
    expect(result.preview).toContain("plain text content");
  });

  test("404 response throws with status message", async () => {
    mockFetch("Not Found", "text/html", 404);

    await expect(
      fetchAndIndex("https://example.com/missing", store),
    ).rejects.toThrow("Fetch failed: 404 Not Found");
  });

  test("source defaults to hostname when not provided", async () => {
    mockFetch(SAMPLE_HTML);

    const result = await fetchAndIndex(
      "https://docs.example.org/guide",
      store,
    );

    expect(result.source).toBe("docs.example.org");
  });

  test("preview is ~3KB or less", async () => {
    // Generate a large HTML page
    const bigBody = "<p>" + "word ".repeat(2000) + "</p>";
    const bigHtml = `<html><body><h1>Big</h1>${bigBody}</body></html>`;
    mockFetch(bigHtml);

    const result = await fetchAndIndex("https://example.com/big", store);

    // Preview should not exceed ~3KB + the truncation suffix
    expect(result.preview.length).toBeLessThanOrEqual(3100);
    expect(result.preview).toContain("...use search() for full content");
  });

  test("different source same URL causes re-fetch", async () => {
    mockFetch(SAMPLE_HTML);

    const r1 = await fetchAndIndex("https://example.com/page", store, {
      source: "source-a",
    });
    const r2 = await fetchAndIndex("https://example.com/page", store, {
      source: "source-b",
    });

    expect(r1.cached).toBe(false);
    expect(r1.source).toBe("source-a");
    expect(r2.cached).toBe(false);
    expect(r2.source).toBe("source-b");
    // Different source = different cache key, so fetch called twice
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("empty response body yields no chunks", async () => {
    mockFetch("", "text/plain");

    const result = await fetchAndIndex("https://example.com/empty", store);

    expect(result.chunksIndexed).toBe(0);
    expect(result.preview).toBe("");
    expect(result.cached).toBe(false);
  });
});
