// src/context-mode/routing.ts — Tool routing classification helpers
import type { ContextModeStatus } from "./detector.js";

/** HTTP command patterns for blocking */
const HTTP_PATTERNS = [
  /^\s*curl\s/,
  /^\s*wget\s/,
  /\bcurl\s+(-[a-zA-Z]*\s+)*https?:\/\//,
  /\bwget\s+(-[a-zA-Z]*\s+)*https?:\/\//,
];

/** Bash commands that are search/find operations */
const BASH_SEARCH_PATTERNS = [
  /^\s*find\s+/,
  /^\s*grep\s+/,
  /^\s*rg\s+/,
  /^\s*ag\s+/,
  /^\s*fd\s+/,
  /^\s*ack\s+/,
];

/** Bash commands that are always allowed through (even with piped grep) */
const BASH_ALLOWED_PREFIXES = [
  /^\s*git\s/, /^\s*ls\b/, /^\s*mkdir\s/, /^\s*rm\s/, /^\s*mv\s/,
  /^\s*cp\s/, /^\s*cd\s/, /^\s*echo\s/, /^\s*cat\s/, /^\s*npm\s/,
  /^\s*yarn\s/, /^\s*pnpm\s/, /^\s*node\s/, /^\s*python/, /^\s*pip\s/,
  /^\s*touch\s/, /^\s*chmod\s/, /^\s*chown\s/, /^\s*docker\s/,
  /^\s*brew\s/, /^\s*npx\s/, /^\s*vitest\s/, /^\s*jest\s/, /^\s*tsc\b/,
];

/** Check if a bash command is an HTTP request (curl/wget) */
export function isHttpCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return HTTP_PATTERNS.some((p) => p.test(command));
}

/** Check if a bash command is a search/find operation that should be routed to ctx_execute */
export function isBashSearchCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (BASH_ALLOWED_PREFIXES.some((p) => p.test(command))) return false;
  return BASH_SEARCH_PATTERNS.some((p) => p.test(command));
}

/** Check if a Read call is a full-file read (no limit/offset = likely analysis, not edit prep) */
export function isFullFileRead(input: Record<string, unknown> | undefined): boolean {
  if (!input) return true;
  return input.limit == null && input.offset == null;
}

/** Block result returned by routing functions */
export interface BlockResult {
  block: true;
  reason: string;
}

/** Route a tool call — returns a block result if the tool should be redirected, undefined otherwise */
export function routeToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  status: ContextModeStatus,
  options: { enforceRouting: boolean; blockHttpCommands: boolean },
): BlockResult | undefined {
  if (!status.available) return undefined;

  // Grep → block, redirect to ctx_search
  if (options.enforceRouting && toolName === "grep") {
    if (!status.tools.ctxSearch) return undefined;
    return {
      block: true,
      reason:
        'Use ctx_search(queries: ["<pattern>"]) or ctx_batch_execute instead of Grep. ' +
        "Results are indexed and compressed to save context window.",
    };
  }

  // Find/Glob → block, redirect to ctx_execute or ctx_batch_execute
  if (options.enforceRouting && toolName === "find") {
    if (!status.tools.ctxExecute) return undefined;
    return {
      block: true,
      reason:
        'Use ctx_execute(language: "shell", code: "find ...") or ctx_batch_execute instead of Find/Glob. ' +
        "Results are indexed and compressed to save context window.",
    };
  }

  // Fetch/WebFetch → block, redirect to ctx_fetch_and_index
  if (toolName === "fetch" || toolName === "web_fetch") {
    if (!status.tools.ctxFetchAndIndex) return undefined;
    return {
      block: true,
      reason:
        "Use ctx_fetch_and_index instead of Fetch/WebFetch. " +
        "It fetches the URL, indexes the content, and returns a compressed summary.",
    };
  }

  // Read (full-file, no limit/offset) → block, redirect to ctx_execute_file
  if (options.enforceRouting && toolName === "read") {
    if (!status.tools.ctxExecuteFile) return undefined;
    if (!isFullFileRead(input)) return undefined;
    return {
      block: true,
      reason:
        "Use ctx_execute_file(path, language, code) for file analysis instead of Read. " +
        "If you need to Read before editing, re-call with a limit parameter.",
    };
  }

  // Bash routing
  if (toolName === "bash") {
    const command = input?.command;

    // Bash search commands → block, redirect to ctx_execute
    if (options.enforceRouting && isBashSearchCommand(command)) {
      if (!status.tools.ctxExecute) return undefined;
      return {
        block: true,
        reason:
          'Use ctx_execute(language: "shell", code: "<command>") instead of Bash for search commands. ' +
          "For multiple commands, use ctx_batch_execute. Results stay in sandbox and are auto-indexed.",
      };
    }

    // Bash HTTP commands → block, redirect to ctx_fetch_and_index
    if (options.blockHttpCommands && isHttpCommand(command)) {
      if (!status.tools.ctxFetchAndIndex) return undefined;
      return {
        block: true,
        reason:
          "Use ctx_fetch_and_index instead of curl/wget. " +
          "It fetches the URL, indexes the content, and returns a compressed summary.",
      };
    }
  }

  return undefined;
}
