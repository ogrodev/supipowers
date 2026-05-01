// src/context-mode/compressor.ts
import { canonicalToolName } from "./tool-name.js";
import type { ContextModeProcessorsConfig } from "../types.js";
import type { ProcessorKey } from "./metrics-store.js";
import { processorKeyForTool } from "./processor-keys.js";
import { lookupProcessor } from "./processors/registry.js";

interface ToolResultEventLike {
  toolName: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  details: unknown;
}

interface ToolResultEventResult {
  content?: Array<{ type: string; text: string }>;
}

export interface RunEmissionPipelineOptions {
  processors?: ContextModeProcessorsConfig;
}

export interface PipelineResult {
  result: ToolResultEventResult | undefined;
  processorKey: ProcessorKey;
}

const BASH_HEAD_LINES = 5;
const BASH_TAIL_LINES = 10;
const READ_HEAD_LINES = 80;
const READ_TAIL_LINES = 30;
const SEARCH_MAX_MATCHES = 10;
const FIND_MAX_PATHS = 20;

/**
 * OMP's `shellMinimizer` already shrinks bash output and appends this footer
 * pointing at the full bytes. When we see it, supipowers must NOT re-compress —
 * doing so would either drop the pointer or double-truncate already-trimmed text.
 * The artifact id is recoverable via `read artifact://<id>`.
 */
export const OMP_MINIMIZER_FOOTER_RE = /(?:^|\n)\[raw output: artifact:\/\/[a-zA-Z0-9_-]+\]\s*$/;


/** Measure total byte length of text content entries */
function measureTextBytes(content: Array<{ type: string; text?: string }>): number {
  let total = 0;
  for (const entry of content) {
    if (entry.type === "text" && entry.text) {
      total += new TextEncoder().encode(entry.text).byteLength;
    }
  }
  return total;
}

/** Check if content contains any non-text entries */
function hasNonTextContent(content: Array<{ type: string }>): boolean {
  return content.some((entry) => entry.type !== "text");
}

/** Get combined text from all text content entries */
function getCombinedText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((entry) => entry.type === "text" && entry.text)
    .map((entry) => entry.text!)
    .join("\n");
}

function exitCodeFromDetails(details: unknown): number | null {
  if (details && typeof details === "object" && "exitCode" in details) {
    const exitCode = (details as { exitCode?: unknown }).exitCode;
    return typeof exitCode === "number" ? exitCode : null;
  }
  return null;
}

function eolOf(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function wrapText(text: string): ToolResultEventResult {
  return { content: [{ type: "text", text }] };
}

/** Compress bash tool output */
function compressBash(text: string, details: unknown): string | undefined {
  const exitCode =
    details && typeof details === "object" && "exitCode" in details
      ? (details as { exitCode: number }).exitCode
      : 0;

  // Already minimized by OMP — pass through to preserve the artifact pointer.
  if (OMP_MINIMIZER_FOOTER_RE.test(text)) return undefined;

  // Non-zero exit: keep full output for debugging
  if (exitCode !== 0) return undefined;

  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= BASH_HEAD_LINES + BASH_TAIL_LINES) return undefined;

  const head = lines.slice(0, BASH_HEAD_LINES);
  const tail = lines.slice(-BASH_TAIL_LINES);
  const omitted = totalLines - BASH_HEAD_LINES - BASH_TAIL_LINES;

  return [
    ...head,
    `[...compressed: ${omitted} lines omitted (${totalLines} lines total)...]`,
    ...tail,
  ].join("\n");
}

/** Compress read tool output — head+tail with hashline preservation */
function compressRead(text: string, input: Record<string, unknown>): string | undefined {
  // Already minimized by OMP (e.g. when reading a `bash-original` artifact back). Pass through.
  if (OMP_MINIMIZER_FOOTER_RE.test(text)) return undefined;

  // Scoped reads (offset/limit/sel) are already targeted — pass through
  if (input.offset != null || input.limit != null || input.sel != null) return undefined;

  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= READ_HEAD_LINES + READ_TAIL_LINES) return undefined;

  const head = lines.slice(0, READ_HEAD_LINES);
  const tail = lines.slice(-READ_TAIL_LINES);
  const omittedStart = READ_HEAD_LINES + 1;
  const omittedEnd = totalLines - READ_TAIL_LINES;

  return [
    ...head,
    `[...${omittedEnd - omittedStart + 1} lines omitted. Use read(path, sel="L${omittedStart}-L${omittedEnd}") to view...]`,
    ...tail,
  ].join("\n");
}

/** Compress search tool output */
function compressSearch(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalMatches = lines.length;

  if (totalMatches <= SEARCH_MAX_MATCHES) return undefined;

  const kept = lines.slice(0, SEARCH_MAX_MATCHES);
  return [
    `${totalMatches} matches total, showing first ${SEARCH_MAX_MATCHES}:`,
    "",
    ...kept,
    `[...compressed: ${totalMatches - SEARCH_MAX_MATCHES} more matches omitted...]`,
  ].join("\n");
}

/** Compress find tool output */
function compressFind(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalFiles = lines.length;

  if (totalFiles <= FIND_MAX_PATHS) return undefined;

  const kept = lines.slice(0, FIND_MAX_PATHS);
  return [
    `${totalFiles} files found, showing first ${FIND_MAX_PATHS}:`,
    "",
    ...kept,
    `[...compressed: ${totalFiles - FIND_MAX_PATHS} more files omitted...]`,
  ].join("\n");
}

/** Run the deterministic emission pipeline and report the processor decision. */
export function runEmissionPipeline(
  event: ToolResultEventLike,
  threshold: number,
  options: RunEmissionPipelineOptions = {},
): PipelineResult {
  const canonicalTool = canonicalToolName(event.toolName);
  const nativeProcessorKey = processorKeyForTool(canonicalTool);
  const passthroughProcessorKey: ProcessorKey = nativeProcessorKey === null ? null : "passthrough";

  // General rules: pass through errors, non-text content, and small outputs.
  if (event.isError) return { result: undefined, processorKey: passthroughProcessorKey };
  if (hasNonTextContent(event.content)) return { result: undefined, processorKey: passthroughProcessorKey };

  const byteSize = measureTextBytes(event.content);
  if (byteSize <= threshold) {
    return {
      result: undefined,
      processorKey: passthroughProcessorKey,
    };
  }

  const text = getCombinedText(event.content);

  if (canonicalTool === "bash" && OMP_MINIMIZER_FOOTER_RE.test(text)) {
    return { result: undefined, processorKey: "omp-minimizer" };
  }

  if (canonicalTool === "bash") {
    const match = lookupProcessor(canonicalTool, event.input, text, options);
    if (match) {
      const output = match.processor(text, {
        exitCode: exitCodeFromDetails(event.details),
        eol: eolOf(text),
      });
      if (!output.passthrough) {
        return { result: wrapText(output.text), processorKey: output.processorKey };
      }
    }
  }

  let compressed: string | undefined;
  switch (canonicalTool) {
    case "bash":
      compressed = compressBash(text, event.details);
      break;
    case "read":
      compressed = compressRead(text, event.input);
      break;
    case "search":
      compressed = compressSearch(text);
      break;
    case "find":
      compressed = compressFind(text);
      break;
    default:
      return { result: undefined, processorKey: null };
  }

  if (!compressed) return { result: undefined, processorKey: "passthrough" };
  return { result: wrapText(compressed), processorKey: nativeProcessorKey };
}

/** Compress a tool result if it exceeds the threshold */
export function compressToolResult(
  event: ToolResultEventLike,
  threshold: number,
): ToolResultEventResult | undefined {
  return runEmissionPipeline(event, threshold).result;
}

/** Summarization prompt templates by tool type */
const SUMMARIZE_PROMPTS: Record<string, string> = {
  bash: "Summarize this command output. Preserve: exit code, key findings, error messages, file paths mentioned. Be concise (under 200 words).",
  read: "Summarize this file content. Preserve: file structure, key exports/functions, notable patterns. Be concise (under 200 words).",
  search: "Summarize these search results. Preserve: match count, most relevant matches, file distribution. Be concise (under 200 words).",
  find: "Summarize these file paths. Preserve: directory structure, file count, key patterns. Be concise (under 200 words).",
};

/** Compress with optional LLM summarization for very large outputs */
export async function compressToolResultWithLLM(
  event: ToolResultEventLike,
  threshold: number,
  llmThreshold: number,
  summarize: (text: string, toolName: string) => Promise<string>,
): Promise<ToolResultEventResult | undefined> {
  // General rules
  if (event.isError) return undefined;
  if (hasNonTextContent(event.content)) return undefined;
  const byteSize = measureTextBytes(event.content);
  if (byteSize <= threshold) return undefined;

  const text = getCombinedText(event.content);

  // Below LLM threshold: use structural compression
  if (byteSize < llmThreshold) {
    return compressToolResult(event, threshold);
  }

  // Above LLM threshold: try LLM summarization
  try {
    const prompt = SUMMARIZE_PROMPTS[canonicalToolName(event.toolName)] ?? "Summarize this output concisely (under 200 words).";
    const summary = await summarize(`${prompt}\n\n${text}`, event.toolName);

    // Validate: non-empty and reasonably sized
    if (summary && summary.length >= 50) {
      return { content: [{ type: "text", text: summary }] };
    }
  } catch {
    // Fall through to structural compression
  }

  // Fallback
  return compressToolResult(event, threshold);
}
