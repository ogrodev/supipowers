// src/context-mode/tools.ts
//
// Registers native context-mode tools via platform.registerTool().
// Orchestration layer: delegates execution to sandbox, owns intent-driven
// filtering (auto-indexing large output into knowledge store).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Platform } from "../platform/types.js";
import { executeCode } from "./sandbox/executor.js";
import { getSupportedLanguages } from "./sandbox/runners.js";
import { chunkMarkdown } from "./knowledge/chunker.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { getCacheStore, getMetricsStore, getSessionId } from "./hooks.js";
import { fetchAndIndex } from "./web/fetcher.js";
import { parseCacheHandle } from "./cache-handle.js";
import { sliceCachedText } from "./cache-preview.js";
import { buildRepoMap } from "./repomap.js";
import { canonicalizeSourcePath } from "./source-hash.js";

/** Threshold (bytes) above which intent-driven filtering kicks in. */
const INTENT_THRESHOLD = 5 * 1024;

/**
 * Hard cap on tool response text. Prevents oversized responses from
 * exceeding model API limits (10MB). Leaves generous headroom.
 */
const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB

/** Truncate tool response text to MAX_RESPONSE_SIZE with a follow-up hint. */
function capResponseSize(text: string): string {
  if (text.length <= MAX_RESPONSE_SIZE) return text;
  const truncated = text.slice(0, MAX_RESPONSE_SIZE);
  // Cut at last newline to avoid mid-line truncation
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > MAX_RESPONSE_SIZE * 0.8 ? truncated.slice(0, lastNewline) : truncated;
  return (
    clean +
    `\n\n[... output truncated at ${(MAX_RESPONSE_SIZE / 1024).toFixed(0)}KB. Use ctx_search(queries) for targeted follow-up.]`
  );
}

/** Per-session, in-memory stats. Reset on session restart. */
interface ToolStats {
  calls: Record<string, number>;
  bytesReturned: number;
}

const stats: ToolStats = { calls: {}, bytesReturned: 0 };

function trackCall(toolName: string, outputBytes: number): void {
  stats.calls[toolName] = (stats.calls[toolName] ?? 0) + 1;
  stats.bytesReturned += outputBytes;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function stripCurrentDirPrefixBeforeWindowsAbsolute(p: string): string {
  return p.replace(/^\.[\\/]+(?=[A-Za-z]:[\\/])/, "");
}

function resolveNativeFilePath(filePath: string, cwd = process.cwd()): string {
  const normalized = stripCurrentDirPrefixBeforeWindowsAbsolute(filePath);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}


function currentKnowledgeOwner() {
  return { ownerScope: "session" as const, ownerId: getSessionId() };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordCacheOpenMetric(opts: { beforeBytes: number; afterBytes: number; cacheHit: 0 | 1 }): void {

  const metrics = getMetricsStore();
  if (!metrics) return;

  try {
    metrics.record({
      session_id: getSessionId(),
      ts: Date.now(),
      layer: "L3",
      tool: "ctx_open_cached",
      processor: "cache-open",
      before_bytes: Math.max(0, Math.floor(opts.beforeBytes)),
      after_bytes: Math.max(0, Math.floor(opts.afterBytes)),
      cache_hit: opts.cacheHit,
      unique_source_hash: null,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
  } catch {
    // Cache reads must not depend on metrics health.
  }
}


function recordRequestCacheMetric(opts: { tool: string; beforeBytes: number; afterBytes: number; cacheHit: 0 | 1 }): void {
  const metrics = getMetricsStore();
  if (!metrics) return;
  try {
    metrics.record({
      session_id: getSessionId(),
      ts: Date.now(),
      layer: "L3",
      tool: opts.tool,
      processor: "cache-open",
      before_bytes: Math.max(0, Math.floor(opts.beforeBytes)),
      after_bytes: Math.max(0, Math.floor(opts.afterBytes)),
      cache_hit: opts.cacheHit,
      unique_source_hash: null,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
  } catch {
    // Request-cache metrics are best-effort.
  }
}

function recordL4RetrievalMetric(tool: "ctx_repomap" | "ctx_symbol", beforeBytes: number, afterBytes: number): void {
  const metrics = getMetricsStore();
  if (!metrics) return;
  try {
    metrics.record({
      session_id: getSessionId(),
      ts: Date.now(),
      layer: "L4",
      tool,
      processor: "passthrough",
      before_bytes: Math.max(0, Math.floor(beforeBytes)),
      after_bytes: Math.max(0, Math.floor(afterBytes)),
      cache_hit: 0,
      unique_source_hash: null,
      context_tokens: null,
      context_window: null,
      context_percent: null,
    });
  } catch {
    // Retrieval metrics are diagnostic-only and must never break tool responses.
  }
}

type KnowledgeStoreProvider = KnowledgeStore | (() => KnowledgeStore | null);

function resolveKnowledgeStore(provider: KnowledgeStoreProvider): KnowledgeStore | null {
  return typeof provider === "function" ? provider() : provider;
}

function requireKnowledgeStore(provider: KnowledgeStoreProvider): KnowledgeStore {
  const store = resolveKnowledgeStore(provider);
  if (!store) throw new Error("Knowledge store unavailable for the active session.");
  return store;
}

/**
 * If output exceeds INTENT_THRESHOLD and an intent is provided, auto-index
 * the output and return search results instead of raw text.
 */
function maybeFilterByIntent(
  output: string,
  intent: string | undefined,
  source: string,
  store: KnowledgeStore | null,
): string {
  if (!store) return output;
  if (!intent || output.length < INTENT_THRESHOLD) return output;

  const chunks = chunkMarkdown(output, source);
  if (chunks.length === 0) return output;

  store.index(chunks, source, currentKnowledgeOwner());
  const results = store.search([intent], { source, limit: 5, owner: currentKnowledgeOwner() });

  const sections = chunks.map((c) => `- ${c.title || "(untitled)"} (${c.body.length}B)`).join("\n");

  let text = `## Indexed Sections\n\n${sections}\n\n`;
  for (const group of results) {
    text += `## ${group.query}\n\n`;
    for (const r of group.results) {
      text += `### ${r.title}\n${r.body}\n\n`;
    }
  }

  const terms = extractSearchableTerms(output);
  if (terms.length > 0) {
    text += `\nSearchable terms for follow-up: ${terms.join(", ")}`;
  }

  return text;
}

/** Extract distinctive terms from output for search vocabulary hints. */
function extractSearchableTerms(text: string): string[] {
  const words = text.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    const lower = w.toLowerCase();
    freq.set(lower, (freq.get(lower) ?? 0) + 1);
  }
  // Return top distinctive terms (appear 2-10 times — not too common, not too rare)
  return [...freq.entries()]
    .filter(([, count]) => count >= 2 && count <= 10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([term]) => term);
}

/** Inject FILE_CONTENT variable per language. */
function injectFileContent(language: string, fileContent: string, code: string): string {
  const escaped = (s: string, char: string) => s.replaceAll(char, `\\${char}`);

  switch (language) {
    case "javascript":
    case "typescript":
      return `const FILE_CONTENT = \`${escaped(escaped(fileContent, "\\"), "\`")}\`;\n${code}`;
    case "python":
      return `FILE_CONTENT = """${fileContent.replaceAll('"""', '\\"\\"\\"')}"""\n${code}`;
    case "shell":
      return `FILE_CONTENT='${fileContent.replaceAll("'", "'\"'\"'")}'\n${code}`;
    case "ruby":
      return `FILE_CONTENT = <<~'HEREDOC'\n${fileContent}\nHEREDOC\n${code}`;
    case "elixir":
      return `file_content = ~S"""\n${fileContent}\n"""\n${code}`;
    case "go":
      return `package main\nimport "fmt"\nvar FILE_CONTENT = \`${fileContent.replaceAll("`", "` + \"`\" + `")}\`\nfunc init() { _ = fmt.Sprintf("%s", FILE_CONTENT) }\n${code}`;
    case "php":
      return `<?php\n$FILE_CONTENT = <<<'HEREDOC'\n${fileContent}\nHEREDOC;\n?>${code}`;
    case "perl":
      return `my $FILE_CONTENT = <<'HEREDOC';\n${fileContent}\nHEREDOC\n${code}`;
    case "r":
      return `FILE_CONTENT <- "${fileContent.replaceAll('"', '\\"').replaceAll("\n", "\\n")}"\n${code}`;
    case "rust":
      return `const FILE_CONTENT: &str = r###"${fileContent}"###;\n${code}`;
    default:
      // Fallback: shell-style for unknown
      return `FILE_CONTENT='${fileContent.replaceAll("'", "'\"'\"'")}'\n${code}`;
  }
}

/** Format search results into readable text. */
function formatSearchResults(grouped: ReturnType<KnowledgeStore["search"]>): string {
  if (grouped.length === 0) return "No results.";
  let text = "";
  for (const group of grouped) {
    text += `## ${group.query}\n\n`;
    if (group.results.length === 0) {
      text += "No matches.\n\n";
      continue;
    }
    for (const r of group.results) {
      text += `### ${r.title || "(untitled)"}\n`;
      text += `--- [${r.source}] ---\n`;
      text += `${r.body}\n\n`;
    }
  }
  return text;
}

// ── Auto-index bootstrap for ctx_search ────────────────────────────

/** Extensions worth scanning when bootstrapping the knowledge store. */
const AUTO_INDEX_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".md", ".mdx", ".txt", ".rst",
  ".yaml", ".yml", ".toml", ".json",
  ".sh", ".bash", ".zsh",
  ".html", ".css", ".scss",
  ".sql",
]);

/** Directory names to skip during bootstrap scan. */
const AUTO_INDEX_SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "dist", "build", "out", ".next", ".nuxt", ".cache", ".turbo", ".bun",
  "coverage", "vendor", "target", "__pycache__", ".venv", "venv",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  "tmp", ".tmp", ".idea", ".vscode",
]);

const AUTO_INDEX_MAX_FILES = 80;
const AUTO_INDEX_MAX_SCAN = 4000;
const AUTO_INDEX_MAX_FILE_BYTES = 256 * 1024;
const AUTO_INDEX_MAX_DEPTH = 8;
const AUTO_INDEX_MIN_TERM_LEN = 3;

/**
 * Sessions for which bootstrap should NOT run again. A `sessionKey` lands
 * here when bootstrap was either successful (chunks indexed) or definitively
 * barren (no scannable files in the cwd at all) — neither warrants a retry.
 */
const _autoIndexAttempted = new Set<string>();

/**
 * Per-session memoization of failed bootstrap scans, keyed by the query-term
 * fingerprint. A scan that walked files but produced zero indexed chunks is
 * not retried for the same fingerprint, but a different fingerprint (i.e. a
 * reformulated query) is allowed through.
 */
const _autoIndexNoMatchByQuery = new Map<string, Set<string>>();

/** Reset auto-index attempt tracking. Test-only. */
export function _resetAutoIndexAttempts(): void {
  _autoIndexAttempted.clear();
  _autoIndexNoMatchByQuery.clear();
}

/** Compute the per-query fingerprint used to gate retries on no-match scans. */
function autoIndexQueryFingerprint(queries: string[]): string {
  return extractIndexTerms(queries).slice().sort().join("|");
}

/** Drop bootstrap-attempted entries that belong to a closed session. */
export function _forgetAutoIndexSession(ownerId: string): void {
  if (!ownerId) return;
  const prefix = `${ownerId}|`;
  for (const key of _autoIndexAttempted) {
    if (key.startsWith(prefix)) _autoIndexAttempted.delete(key);
  }
  for (const key of [..._autoIndexNoMatchByQuery.keys()]) {
    if (key.startsWith(prefix)) _autoIndexNoMatchByQuery.delete(key);
  }
}

function extractIndexTerms(queries: string[]): string[] {
  const terms = new Set<string>();
  for (const query of queries) {
    if (typeof query !== "string") continue;
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
    for (const token of tokens) {
      if (token.length >= AUTO_INDEX_MIN_TERM_LEN) terms.add(token);
    }
  }
  return [...terms];
}

/**
 * Bootstrap the knowledge store by scanning `cwd` for files containing any of
 * the query terms, then indexing those files. Used when ctx_search is called
 * against an empty store — without this, search can never return useful
 * results until the agent manually runs ctx_index/ctx_batch_execute.
 *
 * Returns the number of chunks indexed. Caller should re-search after.
 */
export function autoIndexFromCwd(
  store: KnowledgeStore,
  queries: string[],
  cwd: string,
  owner: { ownerScope: "session"; ownerId: string },
): { chunksIndexed: number; filesIndexed: number; filesScanned: number } {
  const terms = extractIndexTerms(queries);
  if (terms.length === 0) return { chunksIndexed: 0, filesIndexed: 0, filesScanned: 0 };

  const matched: string[] = [];
  let filesScanned = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > AUTO_INDEX_MAX_DEPTH) return;
    if (matched.length >= AUTO_INDEX_MAX_FILES) return;
    if (filesScanned >= AUTO_INDEX_MAX_SCAN) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matched.length >= AUTO_INDEX_MAX_FILES) return;
      if (filesScanned >= AUTO_INDEX_MAX_SCAN) return;
      const name = entry.name;
      if (name.startsWith(".") && name !== "." && name !== "..") {
        // Allow a few well-known dotted source dirs but skip caches/VCS.
        if (AUTO_INDEX_SKIP_DIRS.has(name)) continue;
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (AUTO_INDEX_SKIP_DIRS.has(name)) continue;
        walk(join(dir, name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (!AUTO_INDEX_EXTENSIONS.has(ext)) continue;
      const full = join(dir, name);
      filesScanned++;
      let body: string;
      try {
        const stat = statSync(full);
        if (stat.size > AUTO_INDEX_MAX_FILE_BYTES) continue;
        body = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const lower = body.toLowerCase();
      if (terms.some((t) => lower.includes(t))) {
        matched.push(full);
      }
    }
  };

  walk(cwd, 0);

  if (matched.length === 0) {
    return { chunksIndexed: 0, filesIndexed: 0, filesScanned };
  }

  let chunksIndexed = 0;
  for (const file of matched) {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[\\/]+/, "") : file;
    const source = `auto-index:${rel}`;
    // Wrap with a markdown title so the chunker assigns a useful heading.
    const chunks = chunkMarkdown(`# ${rel}\n\n${body}`, source);
    if (chunks.length === 0) continue;
    store.index(chunks, source, owner);
    chunksIndexed += chunks.length;
  }

  return { chunksIndexed, filesIndexed: matched.length, filesScanned };
}

export interface RegisterContextModeToolsOptions {
  repomap?: { enabled?: boolean; tokenBudget: number; maxFiles: number };
  knowledgeToolsEnabled?: boolean;
}

export function registerContextModeTools(
  platform: Platform,
  storeProvider: KnowledgeStoreProvider,
  options: RegisterContextModeToolsOptions = {},
): void {
  if (!platform.registerTool) return;

  const languages = getSupportedLanguages();
  const knowledgeToolsEnabled = options.knowledgeToolsEnabled !== false;

  // ── ctx_execute ────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_execute",
    label: "Execute Code in Sandbox",
    description:
      "Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess. Use for: API calls, test runners, git queries, data processing, and any command that may produce large output.",
    promptSnippet: "ctx_execute — run code in sandbox, only stdout enters context",
    promptGuidelines: [
      "Prefer this over bash for commands producing >20 lines of output",
      "Use `intent` parameter when output may be large — triggers auto-indexing and returns search results",
      "Use `background: true` for long-running servers/daemons",
    ],
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: languages, description: "Runtime language" },
        code: { type: "string", description: "Source code to execute" },
        intent: { type: "string", description: "What you're looking for in the output. When provided and output is large (>5KB), auto-indexes and returns matching sections." },
        timeout: { type: "number", description: "Max execution time in ms (default: 30000)" },
        background: { type: "boolean", description: "Keep process running after timeout (for servers/daemons)" },
      },
      required: ["language", "code"],
    },
    async execute(_toolCallId: string, params: any) {
      const { language, code, intent, timeout, background } = params;
      const result = await executeCode(language, code, { timeout, background });

      let output = result.stdout;
      if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
      if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;

      const source = `ctx_execute:${language}:${Date.now()}`;
      output = maybeFilterByIntent(output, intent, source, resolveKnowledgeStore(storeProvider));

      trackCall("ctx_execute", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });

  // ── ctx_execute_file ───────────────────────────────────────
  platform.registerTool({
    name: "ctx_execute_file",
    label: "Execute Code with File Content",
    description:
      "Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.",
    promptSnippet: "ctx_execute_file — process file in sandbox, only printed summary enters context",
    promptGuidelines: [
      "Prefer this over Read for large files when you need to extract specific information",
      "FILE_CONTENT variable is automatically injected in the target language",
    ],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        language: { type: "string", enum: languages, description: "Runtime language" },
        code: { type: "string", description: "Code to process FILE_CONTENT. Print summary via console.log/print/echo." },
        intent: { type: "string", description: "What you're looking for in the output" },
        timeout: { type: "number", description: "Max execution time in ms (default: 30000)" },
        cache: { type: "boolean", description: "Opt into request caching for deterministic file-processing calls" },
        cacheTtlMs: { type: "number", description: "Request cache TTL in milliseconds (default: 300000)" },
      },
      required: ["path", "language", "code"],
    },
    async execute(_toolCallId: string, params: any) {
      const { path: filePath, language, code, intent, timeout, cache, cacheTtlMs } = params;
      const nativeFilePath = resolveNativeFilePath(String(filePath));
      const canonicalFilePath = canonicalizeSourcePath(nativeFilePath, process.cwd());
      const fileContent = readFileSync(nativeFilePath, "utf-8");
      const fileHash = sha256Text(fileContent);
      const cacheStore = cache === true ? getCacheStore() : null;
      const requestCacheArgs = {
        path: canonicalFilePath,
        language,
        codeHash: sha256Text(String(code)),
        timeout: timeout ?? null,
        intent: typeof intent === "string" ? intent : null,
        fileHash,
      };
      const argsHash = sha256Text(stableStringify(requestCacheArgs));
      const fingerprint = fileHash;
      if (cacheStore) {
        const cached = cacheStore.getRequestCache({
          tool: "ctx_execute_file",
          argsHash,
          cwd: process.cwd(),
          fingerprint,
        });
        if (cached.hit) {
          const opened = cacheStore.openText(cached.handle);
          if (opened.ok) {
            const output = `[cache hit: ${cached.handle}]\n${opened.text}`;
            recordRequestCacheMetric({
              tool: "ctx_execute_file",
              beforeBytes: opened.meta.sizeBytes,
              afterBytes: byteLength(output),
              cacheHit: 1,
            });
            trackCall("ctx_execute_file", output.length);
            return { content: [{ type: "text", text: capResponseSize(output) }] };
          }
        }
      }

      const augmentedCode = injectFileContent(language, fileContent, code);

      const result = await executeCode(language, augmentedCode, { timeout });

      let output = result.stdout;
      if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
      if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;

      const source = `ctx_execute_file:${canonicalFilePath}:${Date.now()}`;
      output = maybeFilterByIntent(output, intent, source, resolveKnowledgeStore(storeProvider));
      if (cacheStore && result.exitCode === 0) {
        const meta = cacheStore.putText({
          sessionId: getSessionId(),
          text: output,
          sourceTool: "ctx_execute_file",
          sourceHash: argsHash,
          recordMetric: false,
        });
        cacheStore.putRequestCache({
          tool: "ctx_execute_file",
          argsHash,
          cwd: process.cwd(),
          fingerprint,
          handle: meta.handle,
          ttlMs: typeof cacheTtlMs === "number" ? cacheTtlMs : 5 * 60 * 1000,
        });
        recordRequestCacheMetric({
          tool: "ctx_execute_file",
          beforeBytes: byteLength(output),
          afterBytes: byteLength(output),
          cacheHit: 0,
        });
      }

      trackCall("ctx_execute_file", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });

  if (knowledgeToolsEnabled) {
  // ── ctx_batch_execute ──────────────────────────────────────
  platform.registerTool({
    name: "ctx_batch_execute",
    label: "Batch Execute and Search",
    description:
      "Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. Returns search results directly — no follow-up calls needed.",
    promptSnippet: "ctx_batch_execute — run multiple commands + search in one call",
    promptGuidelines: [
      "This is the PRIMARY tool for gathering information",
      "One batch_execute call replaces 30+ execute calls + 10+ search calls",
      "Provide all commands to run and all queries to search",
    ],
    parameters: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Section header for this command's output" },
              command: { type: "string", description: "Shell command to execute" },
            },
            required: ["label", "command"],
          },
          description: "Commands to execute as a batch",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Search queries to extract information from indexed output",
        },
        timeout: { type: "number", description: "Max execution time per command in ms (default: 60000)" },
      },
      required: ["commands", "queries"],
    },
    async execute(_toolCallId: string, params: any) {
      const store = requireKnowledgeStore(storeProvider);
      const { commands, queries, timeout = 60000 } = params;
      const sections: string[] = [];

      // Run each command sequentially, index output
      for (const cmd of commands) {
        const result = await executeCode("shell", cmd.command, { timeout });
        let output = result.stdout;
        if (result.stderr) output += `\n${result.stderr}`;

        const source = `batch:${cmd.label}`;
        const chunks = chunkMarkdown(output, source);
        if (chunks.length > 0) {
          store.index(chunks, source, currentKnowledgeOwner());
        }
        sections.push(`- ${cmd.label} (${(output.length / 1024).toFixed(1)}KB)`);
      }

      // Search across all indexed content
      const results = store.search(queries, { limit: 5, owner: currentKnowledgeOwner() });

      let text = `Executed ${commands.length} commands. Indexed ${sections.length} sections.\n\n`;
      text += `## Indexed Sections\n\n${sections.join("\n")}\n\n`;
      text += formatSearchResults(results);

      const terms = extractSearchableTerms(
        results.flatMap((g) => g.results.map((r) => r.body)).join("\n"),
      );
      if (terms.length > 0) {
        text += `\nSearchable terms for follow-up: ${terms.join(", ")}`;
      }

      trackCall("ctx_batch_execute", text.length);
      return { content: [{ type: "text", text: capResponseSize(text) }] };
    },
  });
  }

  if (knowledgeToolsEnabled) {
  // ── ctx_index ──────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_index",
    label: "Index Content",
    description:
      "Index documentation or knowledge content into a searchable BM25 knowledge base. After indexing, use ctx_search to retrieve specific sections on-demand.",
    promptSnippet: "ctx_index — store content in knowledge base for later search",
    promptGuidelines: [
      "Use when you have raw text or markdown to make searchable later via ctx_search",
      "Use ctx_fetch_and_index instead when the source is a URL",
      "Provide a descriptive `source` label so others can scope ctx_search by source",
    ],
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Raw text/markdown to index. Provide this OR path, not both." },
        path: { type: "string", description: "File path to read and index. Provide this OR content." },
        source: { type: "string", description: "Label for the indexed content (e.g., 'React docs', 'API reference')" },
      },
      required: ["source"],
    },
    async execute(_toolCallId: string, params: any) {
      const store = requireKnowledgeStore(storeProvider);
      const { content, path: filePath, source } = params;

      if ((content && filePath) || (!content && !filePath)) {
        throw new Error("Exactly one of 'content' or 'path' must be provided.");
      }

      const text = filePath ? readFileSync(filePath, "utf-8") : content;
      const chunks = chunkMarkdown(text, source);
      store.index(chunks, source, currentKnowledgeOwner());

      const output = `Indexed ${chunks.length} chunks under source "${source}".`;
      trackCall("ctx_index", output.length);
      return { content: [{ type: "text", text: output }] };
    },
  });
  }

  if (knowledgeToolsEnabled) {
  // ── ctx_search ─────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_search",
    label: "Search Knowledge Base",
    description:
      "Search indexed content. Auto-bootstraps the knowledge store from the project on the first call when nothing is indexed yet — subsequent calls skip auto-indexing.",
    promptSnippet: "ctx_search — query indexed content with BM25 search",
    promptGuidelines: [
      "Use to retrieve specific sections from previously indexed content",
      "Pass ALL questions in the queries array in one call — do not chain ctx_search calls",
      "Filter by `source` when you know which indexed bundle to search",
      "Safe to call on a fresh session: the first call bootstraps an index from the project when none exists",
    ],
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "Array of search queries. Batch ALL questions in one call.",
        },
        source: { type: "string", description: "Filter to a specific indexed source (partial match)" },
        contentType: { type: "string", enum: ["code", "prose"], description: "Filter results by content type" },
        limit: { type: "number", description: "Results per query (default: 3)" },
      },
      required: ["queries"],
    },
    async execute(_toolCallId: string, params: any, _abortSignal?: any, _onUpdate?: any, ctx?: any) {
      const store = requireKnowledgeStore(storeProvider);
      const { queries, source, contentType, limit } = params;
      const owner = currentKnowledgeOwner();

      let results = store.search(queries, { source, contentType, limit, owner });
      let bootstrapNote = "";

      const allEmpty = results.every((g) => g.results.length === 0);
      const sessionKey = `${owner.ownerId}|${source ?? ""}`;
      const queryFingerprint = autoIndexQueryFingerprint(queries);
      const failedFingerprints = _autoIndexNoMatchByQuery.get(sessionKey);
      const canBootstrap =
        allEmpty &&
        Array.isArray(queries) &&
        queries.length > 0 &&
        !source &&
        !_autoIndexAttempted.has(sessionKey) &&
        !(failedFingerprints?.has(queryFingerprint) ?? false);

      if (canBootstrap) {
        const stats = store.getStats();
        if (stats.totalChunks === 0) {
          const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
          let bootstrap;
          try {
            bootstrap = autoIndexFromCwd(store, queries, cwd, owner);
          } catch {
            bootstrap = { chunksIndexed: 0, filesIndexed: 0, filesScanned: 0 };
          }
          if (bootstrap.chunksIndexed > 0) {
            _autoIndexAttempted.add(sessionKey);
            results = store.search(queries, { source, contentType, limit, owner });
            bootstrapNote =
              `[auto-indexed ${bootstrap.filesIndexed} files (${bootstrap.chunksIndexed} chunks) ` +
              `from ${bootstrap.filesScanned} scanned to bootstrap the empty knowledge store]\n\n`;
          } else if (bootstrap.filesScanned > 0) {
            // Scan ran but nothing matched this query fingerprint. Memoize by
            // fingerprint so a reformulated query still gets a fresh scan.
            let set = _autoIndexNoMatchByQuery.get(sessionKey);
            if (!set) {
              set = new Set<string>();
              _autoIndexNoMatchByQuery.set(sessionKey, set);
            }
            set.add(queryFingerprint);
            bootstrapNote =
              `[scanned ${bootstrap.filesScanned} files but none matched the query terms; ` +
              `use ctx_batch_execute or ctx_index to index relevant content explicitly]\n\n`;
          } else {
            // No scannable files at all — cwd is barren. Don't retry, period.
            _autoIndexAttempted.add(sessionKey);
          }
        } else {
          // Store had chunks but the query still missed; record nothing here —
          // the search-side fallback already exhausted its options.
        }
      }

      const output = bootstrapNote + formatSearchResults(results);
      trackCall("ctx_search", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });
  }

  // ── ctx_repomap ─────────────────────────────────────────────
  if (options.repomap?.enabled !== false) {
    platform.registerTool({
      name: "ctx_repomap",
      label: "Repository Map",
      description: "Build a deterministic structural repository map capped by an estimated token budget.",
      promptSnippet: "ctx_repomap — structural repository map with symbols/imports",
      promptGuidelines: [
        "Use before broad code exploration when you need a bounded overview",
        "Pass focus files to personalize ranking toward the current task",
      ],
      parameters: {
        type: "object",
        properties: {
          focus: { type: "array", items: { type: "string" }, description: "Optional focus files for personalized ranking" },
          tokenBudget: { type: "number", description: "Estimated token budget for the emitted map (default: 4000)" },
        },
      },
      async execute(_toolCallId: string, params: any, _abortSignal?: any, _onUpdate?: any, ctx?: any) {
        const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
        const result = await buildRepoMap(platform, {
          cwd,
          focus: Array.isArray(params?.focus) ? params.focus : [],
          tokenBudget: typeof params?.tokenBudget === "number" ? params.tokenBudget : options.repomap?.tokenBudget,
          maxFiles: options.repomap?.maxFiles,
        });
        const output = capResponseSize(result.text);
        const outputBytes = byteLength(output);
        recordL4RetrievalMetric("ctx_repomap", result.emittedSourceBytes, outputBytes);
        trackCall("ctx_repomap", output.length);
        return { content: [{ type: "text", text: output }] };
      },
    });
  }

  // ── ctx_symbol ──────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_symbol",
    label: "Symbol Summary",
    description: "Capability-gated facade for native LSP symbol summaries. Returns an explicit diagnostic when the platform has no callable LSP API.",
    promptSnippet: "ctx_symbol — bounded symbol summary when platform LSP facade is available",
    promptGuidelines: [
      "Use native lsp directly when this reports platform_lsp_facade_unavailable",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or query" },
        action: { type: "string", enum: ["definition", "references", "hover", "symbols"], description: "LSP action" },
      },
      required: ["query"],
    },
    async execute() {
      const text = [
        "platform_lsp_facade_unavailable",
        "The current OMP Platform adapter does not expose a callable native LSP/tool API to extensions.",
        "Use the native lsp tool directly for definitions, references, hover, and symbols.",
      ].join("\n");
      const diagnosticBytes = byteLength(text);
      recordL4RetrievalMetric("ctx_symbol", diagnosticBytes, diagnosticBytes);
      trackCall("ctx_symbol", text.length);
      return { content: [{ type: "text", text }] };
    },
  });

  // ── ctx_open_cached ────────────────────────────────────────
  platform.registerTool({
    name: "ctx_open_cached",
    label: "Open Cached Context Handle",
    description:
      "Open a cache://<sha256> handle and return a bounded slice of cached text with offset metadata.",
    promptSnippet: "ctx_open_cached — open a cache:// handle with bounded offset/limit reads",
    promptGuidelines: [
      "Use when the user provides a cache:// handle or asks to open cached content",
      "Always use offset/limit for follow-up reads instead of requesting the whole payload",
      "Invalid, missing, or corrupt handles return explicit text instead of throwing",
    ],
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "cache://<sha256> handle to open" },
        offset: { type: "number", description: "Character offset in decoded cached text (default: 0)" },
        limit: { type: "number", description: "Maximum characters to return, capped at 100KB characters" },
      },
      required: ["handle"],
    },
    async execute(_toolCallId: string, params: any) {
      const parsed = parseCacheHandle(String(params?.handle ?? ""));
      if (!parsed.ok) {
        const output = `Cannot open cached content: ${parsed.message}.`;
        recordCacheOpenMetric({ beforeBytes: 0, afterBytes: byteLength(output), cacheHit: 0 });
        trackCall("ctx_open_cached", output.length);
        return { content: [{ type: "text", text: capResponseSize(output) }] };
      }

      const cacheStore = getCacheStore();
      if (!cacheStore) {
        const output = "Cannot open cached content: cache store is unavailable for this session.";
        recordCacheOpenMetric({ beforeBytes: 0, afterBytes: byteLength(output), cacheHit: 0 });
        trackCall("ctx_open_cached", output.length);
        return { content: [{ type: "text", text: output }] };
      }

      const opened = cacheStore.openText(parsed.handle);
      if (!opened.ok) {
        recordCacheOpenMetric({ beforeBytes: 0, afterBytes: byteLength(opened.message), cacheHit: 0 });
        trackCall("ctx_open_cached", opened.message.length);
        return { content: [{ type: "text", text: capResponseSize(opened.message) }] };
      }

      // Reserve headroom for the metadata block so capResponseSize never silently drops
      // characters that we already advertised in `Returned`/`Next offset`.
      const HEADER_HEADROOM_CHARS = 512;
      const userLimit = typeof params?.limit === "number" ? params.limit : undefined;
      const responseBudget = Math.max(0, MAX_RESPONSE_SIZE - HEADER_HEADROOM_CHARS);
      const cappedLimit = userLimit === undefined
        ? responseBudget
        : Math.min(userLimit, responseBudget);
      const slice = sliceCachedText(opened.text, params?.offset, cappedLimit);
      const end = slice.offset + slice.returnedChars;
      let output = `## Cached content ${opened.handle}\n\n`;
      output += `- Total: ${opened.meta.sizeBytes} bytes, ${slice.totalChars} chars\n`;
      output += `- Returned: chars ${slice.offset}..${end} of ${slice.totalChars}\n`;
      if (slice.nextOffset !== null) {
        output += `- Next offset: ${slice.nextOffset}\n`;
      }
      output += `\n---\n${slice.text}`;

      recordCacheOpenMetric({
        beforeBytes: opened.meta.sizeBytes,
        afterBytes: byteLength(slice.text),
        cacheHit: 1,
      });
      trackCall("ctx_open_cached", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });

  if (knowledgeToolsEnabled) {
  // ── ctx_fetch_and_index ────────────────────────────────────
  platform.registerTool({
    name: "ctx_fetch_and_index",
    label: "Fetch and Index URL",
    description:
      "Fetch URL content, convert HTML to markdown, index into searchable knowledge base, and return a ~3KB preview. Use ctx_search for deeper lookups.",
    promptSnippet: "ctx_fetch_and_index — fetch URL, index content, return preview",
    promptGuidelines: [
      "Use this instead of curl/wget/WebFetch — raw HTML never enters context",
      "After indexing, use ctx_search for deeper lookups beyond the preview",
    ],
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch and index" },
        source: { type: "string", description: "Label for the indexed content" },
        force: { type: "boolean", description: "Skip cache and re-fetch" },
      },
      required: ["url"],
    },
    async execute(_toolCallId: string, params: any) {
      const store = requireKnowledgeStore(storeProvider);
      const { url, source, force } = params;
      const result = await fetchAndIndex(url, store, { source, force, owner: currentKnowledgeOwner() });

      let output = result.preview;
      if (!result.cached) {
        output += `\n\n---\nIndexed ${result.chunksIndexed} chunks under source "${result.source}". Use ctx_search for deeper lookups.`;
      } else {
        output += `\n\n---\n[Cached] ${result.chunksIndexed} chunks available under source "${result.source}". Use ctx_search for deeper lookups.`;
      }

      trackCall("ctx_fetch_and_index", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });
  }

  // ── ctx_stats ──────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_stats",
    label: "Context Mode Stats",
    description:
      "Returns context consumption statistics for the current session. Shows total bytes returned to context, breakdown by tool, call counts, and knowledge base stats.",
    promptSnippet: "ctx_stats — show session context stats",
    promptGuidelines: [
      "Use only when the user asks about context consumption or to debug context bloat",
      "Do not call this proactively — it consumes context itself",
    ],
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Output format. Defaults to markdown for human reading; json is for tokscale-class consumers.",
        },
      },
    },
    async execute(_id: string, params: any = {}) {
      const store = resolveKnowledgeStore(storeProvider);
      const format = params?.format === "json" ? "json" : "markdown";
      const metricsStore = getMetricsStore();
      const sessionId = getSessionId();

      if (format === "json") {
        const meta = (() => {
          try {
            return metricsStore?.getSessionMeta(sessionId) ?? null;
          } catch {
            return null;
          }
        })();
        const totals = metricsStore
          ? metricsStore.getSessionTotals(sessionId)
          : { beforeBytes: 0, afterBytes: 0, saved: 0, rowCount: 0 };
        const perProcessor = metricsStore ? metricsStore.getTopProcessors(sessionId, 50) : [];
        const perLayer = metricsStore ? metricsStore.getPerLayer(sessionId) : [];
        const uniqueSourceShare = metricsStore
          ? metricsStore.getUniqueSourceShare(sessionId)
          : 0;
        const writeFailures = metricsStore
          ? metricsStore.getSessionWriteFailures(sessionId)
          : 0;
        const tokensEstimated = Math.ceil(totals.saved / 4);
        const payload = {
          session: {
            id: sessionId,
            startedAt: meta?.started_at ?? 0,
            rowCount: totals.rowCount,
          },
          totals: {
            beforeBytes: totals.beforeBytes,
            afterBytes: totals.afterBytes,
            saved: totals.saved,
            tokensEstimated,
          },
          perProcessor,
          perLayer,
          uniqueSourceShare,
          writeFailures,
        };
        const text = JSON.stringify(payload, null, 2);
        trackCall("ctx_stats", text.length);
        return { content: [{ type: "text", text }] };
      }

      // Markdown (default; existing behavior preserved).
      const storeStats = store
        ? store.getStats()
        : { totalChunks: 0, sources: [], dbSizeBytes: 0 };
      const totalCalls = Object.values(stats.calls).reduce((sum, n) => sum + n, 0);
      const estimatedTokens = Math.ceil(stats.bytesReturned / 4); // rough estimate

      let output = "## Context Mode Stats\n\n";
      output += `**Total calls**: ${totalCalls}\n`;
      output += `**Bytes returned to context**: ${(stats.bytesReturned / 1024).toFixed(1)}KB\n`;
      output += `**Estimated tokens consumed**: ~${estimatedTokens.toLocaleString()}\n\n`;

      output += "### Per-tool breakdown\n\n";
      output += "| Tool | Calls |\n|------|-------|\n";
      for (const [name, count] of Object.entries(stats.calls).sort()) {
        output += `| ${name} | ${count} |\n`;
      }

      output += `\n### Knowledge base\n\n`;
      output += `- **Chunks indexed**: ${storeStats.totalChunks}\n`;
      output += `- **Sources**: ${storeStats.sources.length > 0 ? storeStats.sources.join(", ") : "(none)"}\n`;
      output += `- **DB size**: ${(storeStats.dbSizeBytes / 1024).toFixed(1)}KB\n`;

      // Append a Savings panel for the active metrics session, when available.
      if (metricsStore) {
        const totals = metricsStore.getSessionTotals(sessionId);
        const uniqueSourceShare = metricsStore.getUniqueSourceShare(sessionId);
        output += `\n### Session savings (L1 metrics)\n\n`;
        output += `- **Before**: ${(totals.beforeBytes / 1024).toFixed(1)}KB\n`;
        output += `- **After**: ${(totals.afterBytes / 1024).toFixed(1)}KB\n`;
        output += `- **Saved**: ${(totals.saved / 1024).toFixed(1)}KB\n`;
        output += `- **Unique-source share**: ${Math.round(uniqueSourceShare * 100)}%\n`;
      }

      trackCall("ctx_stats", output.length);
      return { content: [{ type: "text", text: output }] };
    },
  });

  if (knowledgeToolsEnabled) {
  // ── ctx_purge ──────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_purge",
    label: "Purge Knowledge Base",
    description:
      "Delete all indexed content from the knowledge base. Does NOT touch the event store (events.db). Use when you want a fresh start.",
    promptSnippet: "ctx_purge — clear all indexed content",
    promptGuidelines: [
      "Use only when the user explicitly asks to reset the knowledge base",
      "Does NOT delete the event store (events.db) — only the knowledge index",
    ],
    parameters: { type: "object", properties: {} },
    async execute() {
      const store = requireKnowledgeStore(storeProvider);
      const count = store.purge();
      // Mark the current session as bootstrap-attempted so a follow-up
      // ctx_search does not undo the explicit purge by re-bootstrapping.
      const owner = currentKnowledgeOwner();
      _autoIndexAttempted.add(`${owner.ownerId}|`);
      const output = `Purged ${count} chunks from knowledge base.`;
      trackCall("ctx_purge", output.length);
      return { content: [{ type: "text", text: output }] };
    },
  });
  }
}

// Exported for testing
export { stats as _stats, INTENT_THRESHOLD };
