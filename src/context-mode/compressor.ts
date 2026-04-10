// src/context-mode/compressor.ts

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

const BASH_HEAD_LINES = 5;
const BASH_TAIL_LINES = 10;
const READ_HEAD_LINES = 80;
const READ_TAIL_LINES = 30;
const GREP_MAX_MATCHES = 10;
const FIND_MAX_PATHS = 20;

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

/** Compress bash tool output */
function compressBash(text: string, details: unknown): string | undefined {
  const exitCode =
    details && typeof details === "object" && "exitCode" in details
      ? (details as { exitCode: number }).exitCode
      : 0;

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

/** Compress grep tool output */
function compressGrep(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalMatches = lines.length;

  if (totalMatches <= GREP_MAX_MATCHES) return undefined;

  const kept = lines.slice(0, GREP_MAX_MATCHES);
  return [
    `${totalMatches} matches total, showing first ${GREP_MAX_MATCHES}:`,
    "",
    ...kept,
    `[...compressed: ${totalMatches - GREP_MAX_MATCHES} more matches omitted...]`,
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

/** Compress a tool result if it exceeds the threshold */
export function compressToolResult(
  event: ToolResultEventLike,
  threshold: number,
): ToolResultEventResult | undefined {
  // General rules: pass through errors, non-text content, and small outputs
  if (event.isError) return undefined;
  if (hasNonTextContent(event.content)) return undefined;
  if (measureTextBytes(event.content) <= threshold) return undefined;

  const text = getCombinedText(event.content);
  let compressed: string | undefined;

  switch (event.toolName) {
    case "bash":
      compressed = compressBash(text, event.details);
      break;
    case "read":
      compressed = compressRead(text, event.input);
      break;
    case "grep":
      compressed = compressGrep(text);
      break;
    case "find":
      compressed = compressFind(text);
      break;
    default:
      return undefined;
  }

  if (!compressed) return undefined;
  return { content: [{ type: "text", text: compressed }] };
}

/** Summarization prompt templates by tool type */
const SUMMARIZE_PROMPTS: Record<string, string> = {
  bash: "Summarize this command output. Preserve: exit code, key findings, error messages, file paths mentioned. Be concise (under 200 words).",
  read: "Summarize this file content. Preserve: file structure, key exports/functions, notable patterns. Be concise (under 200 words).",
  grep: "Summarize these search results. Preserve: match count, most relevant matches, file distribution. Be concise (under 200 words).",
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
    const prompt = SUMMARIZE_PROMPTS[event.toolName] ?? "Summarize this output concisely (under 200 words).";
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
