// src/context-mode/tools.ts
//
// Registers 8 native context-mode tools via platform.registerTool().
// Orchestration layer: delegates execution to sandbox, owns intent-driven
// filtering (auto-indexing large output into knowledge store).

import { readFileSync } from "node:fs";
import type { Platform } from "../platform/types.js";
import { executeCode } from "./sandbox/executor.js";
import { getSupportedLanguages } from "./sandbox/runners.js";
import { chunkMarkdown } from "./knowledge/chunker.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { fetchAndIndex } from "./web/fetcher.js";

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

/**
 * If output exceeds INTENT_THRESHOLD and an intent is provided, auto-index
 * the output and return search results instead of raw text.
 */
function maybeFilterByIntent(
  output: string,
  intent: string | undefined,
  source: string,
  store: KnowledgeStore,
): string {
  if (!intent || output.length < INTENT_THRESHOLD) return output;

  const chunks = chunkMarkdown(output, source);
  if (chunks.length === 0) return output;

  store.index(chunks, source);
  const results = store.search([intent], { source, limit: 5 });

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

export function registerContextModeTools(platform: Platform, store: KnowledgeStore): void {
  if (!platform.registerTool) return;

  const languages = getSupportedLanguages();

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
      output = maybeFilterByIntent(output, intent, source, store);

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
      },
      required: ["path", "language", "code"],
    },
    async execute(_toolCallId: string, params: any) {
      const { path: filePath, language, code, intent, timeout } = params;
      const fileContent = readFileSync(filePath, "utf-8");
      const augmentedCode = injectFileContent(language, fileContent, code);

      const result = await executeCode(language, augmentedCode, { timeout });

      let output = result.stdout;
      if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
      if (result.exitCode !== 0) output += `\n[exit code: ${result.exitCode}]`;

      const source = `ctx_execute_file:${filePath}:${Date.now()}`;
      output = maybeFilterByIntent(output, intent, source, store);

      trackCall("ctx_execute_file", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });

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
          store.index(chunks, source);
        }
        sections.push(`- ${cmd.label} (${(output.length / 1024).toFixed(1)}KB)`);
      }

      // Search across all indexed content
      const results = store.search(queries, { limit: 5 });

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
      const { content, path: filePath, source } = params;

      if ((content && filePath) || (!content && !filePath)) {
        throw new Error("Exactly one of 'content' or 'path' must be provided.");
      }

      const text = filePath ? readFileSync(filePath, "utf-8") : content;
      const chunks = chunkMarkdown(text, source);
      store.index(chunks, source);

      const output = `Indexed ${chunks.length} chunks under source "${source}".`;
      trackCall("ctx_index", output.length);
      return { content: [{ type: "text", text: output }] };
    },
  });

  // ── ctx_search ─────────────────────────────────────────────
  platform.registerTool({
    name: "ctx_search",
    label: "Search Knowledge Base",
    description:
      "Search indexed content. Requires prior indexing via ctx_batch_execute, ctx_index, or ctx_fetch_and_index. Pass ALL search questions as queries array in ONE call.",
    promptSnippet: "ctx_search — query indexed content with BM25 search",
    promptGuidelines: [
      "Use to retrieve specific sections from previously indexed content",
      "Pass ALL questions in the queries array in one call — do not chain ctx_search calls",
      "Filter by `source` when you know which indexed bundle to search",
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
    async execute(_toolCallId: string, params: any) {
      const { queries, source, contentType, limit } = params;
      const results = store.search(queries, { source, contentType, limit });
      const output = formatSearchResults(results);

      trackCall("ctx_search", output.length);
      return { content: [{ type: "text", text: capResponseSize(output) }] };
    },
  });

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
      const { url, source, force } = params;
      const result = await fetchAndIndex(url, store, { source, force });

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
    parameters: { type: "object", properties: {} },
    async execute() {
      const storeStats = store.getStats();
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

      trackCall("ctx_stats", output.length);
      return { content: [{ type: "text", text: output }] };
    },
  });

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
      const count = store.purge();
      const output = `Purged ${count} chunks from knowledge base.`;
      trackCall("ctx_purge", output.length);
      return { content: [{ type: "text", text: output }] };
    },
  });
}

// Exported for testing
export { stats as _stats, INTENT_THRESHOLD };
