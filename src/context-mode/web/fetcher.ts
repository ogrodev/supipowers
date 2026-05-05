import type { KnowledgeOwner } from "../../types.js";
import { type Chunk, chunkMarkdown } from "../knowledge/chunker.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { htmlToMarkdown } from "./html-to-md.js";

export interface FetchOptions {
  /** Label for indexed content; defaults to URL hostname. */
  source?: string;
  /** Bypass 24h TTL cache. */
  force?: boolean;
  /** Ownership scope for indexed/cached content. Defaults to project-owned when omitted. */
  owner?: KnowledgeOwner;
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
  const owner = options?.owner;
  const resolvedOwner = resolveOwner(owner);

  // Check cache unless forced. Explicit owners must be isolated exactly; the
  // default project-owned path also accepts migrated legacy rows so upgraded
  // stores do not refetch and duplicate visible search results.
  if (!options?.force) {
    const cacheOwners = owner ? [resolvedOwner] : [resolvedOwner, { ownerScope: "legacy" as const, ownerId: "" }];
    for (const cacheOwner of cacheOwners) {
      const cached = store.db
        .prepare("SELECT fetched_at FROM url_cache WHERE url = ? AND source = ? AND owner_scope = ? AND owner_id = ?")
        .get(url, source, cacheOwner.ownerScope, cacheOwner.ownerId) as { fetched_at: number } | null;

      if (cached && Date.now() - cached.fetched_at < TTL_MS) {
        return buildCachedResult(store, source, cacheOwner);
      }
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
  store.index(chunks, source, owner);

  store.db.run(
    "INSERT OR REPLACE INTO url_cache (url, source, owner_scope, owner_id, fetched_at) VALUES (?, ?, ?, ?, ?)",
    [url, source, resolvedOwner.ownerScope, resolvedOwner.ownerId, Date.now()],
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

function resolveOwner(owner: KnowledgeOwner | undefined): Required<KnowledgeOwner> {
  return {
    ownerScope: owner?.ownerScope ?? "project",
    ownerId: owner?.ownerId ?? "",
  };
}

/** Reconstruct a cached result by querying stored chunks. */
function buildCachedResult(store: KnowledgeStore, source: string, owner: Required<KnowledgeOwner>): FetchResult {
  const rows = store.db
    .prepare(
      "SELECT title, body, content_type AS contentType FROM content_chunks WHERE source = ? AND owner_scope = ? AND owner_id = ? ORDER BY id",
    )
    .all(source, owner.ownerScope, owner.ownerId) as Chunk[];

  return {
    preview: buildPreview(rows),
    source,
    chunksIndexed: rows.length,
    cached: true,
  };
}
