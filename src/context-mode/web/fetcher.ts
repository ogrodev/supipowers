import { type Chunk, chunkMarkdown } from "../knowledge/chunker.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { htmlToMarkdown } from "./html-to-md.js";

export interface FetchOptions {
  /** Label for indexed content; defaults to URL hostname. */
  source?: string;
  /** Bypass 24h TTL cache. */
  force?: boolean;
}

export interface FetchResult {
  /** ~3KB preview of first chunks. */
  preview: string;
  /** The label used for indexing. */
  source: string;
  chunksIndexed: number;
  /** True if served from url_cache (no network request). */
  cached: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_MAX_CHARS = 3000;

export async function fetchAndIndex(
  url: string,
  store: KnowledgeStore,
  options?: FetchOptions,
): Promise<FetchResult> {
  const source = options?.source ?? new URL(url).hostname;

  // Check cache unless forced
  if (!options?.force) {
    const cached = store.db
      .prepare("SELECT fetched_at FROM url_cache WHERE url = ? AND source = ?")
      .get(url, source) as { fetched_at: number } | null;

    if (cached && Date.now() - cached.fetched_at < TTL_MS) {
      return buildCachedResult(store, source);
    }
  }

  // Fresh fetch
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const rawText = await response.text();
  const markdown = toMarkdown(rawText, contentType);

  const chunks = chunkMarkdown(markdown, source);
  store.index(chunks, source);

  store.db.run(
    "INSERT OR REPLACE INTO url_cache (url, source, fetched_at) VALUES (?, ?, ?)",
    [url, source, Date.now()],
  );

  return {
    preview: buildPreview(chunks),
    source,
    chunksIndexed: chunks.length,
    cached: false,
  };
}

/** Convert raw response text to markdown based on content-type. */
function toMarkdown(text: string, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    return htmlToMarkdown(text);
  }
  if (ct.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

/** Build ~3KB preview from the first N chunks. */
function buildPreview(chunks: Chunk[]): string {
  let out = "";
  let truncated = false;
  for (const chunk of chunks) {
    const section = chunk.title ? `## ${chunk.title}\n${chunk.body}` : chunk.body;
    if (out.length + section.length > PREVIEW_MAX_CHARS) {
      const remaining = PREVIEW_MAX_CHARS - out.length;
      if (remaining > 0) out += section.slice(0, remaining);
      truncated = true;
      break;
    }
    out += (out ? "\n\n" : "") + section;
  }
  if (truncated) {
    out += "\n\n...use search() for full content";
  }
  return out;
}

/** Reconstruct a cached result by querying stored chunks. */
function buildCachedResult(store: KnowledgeStore, source: string): FetchResult {
  const rows = store.db
    .prepare("SELECT title, body, content_type AS contentType FROM content_chunks WHERE source = ? ORDER BY id")
    .all(source) as Chunk[];

  return {
    preview: buildPreview(rows),
    source,
    chunksIndexed: rows.length,
    cached: true,
  };
}
