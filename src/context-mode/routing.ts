// src/context-mode/routing.ts — Tool routing classification helpers
import type { ContextModeStatus } from "./detector.js";

/** HTTP command patterns for blocking */
const HTTP_PATTERNS = [
  /^\s*curl\s/,
  /^\s*wget\s/,
  /\bcurl\s+(-[a-zA-Z]*\s+)*https?:\/\//,
  /\bwget\s+(-[a-zA-Z]*\s+)*https?:\/\//,
  // Inline HTTP patterns
  /\bfetch\s*\(/,
  /\brequests\.(get|post|put|delete|patch)\s*\(/,
  /\bhttp\.(get|request)\s*\(/,
  /\burllib\.request/,
  /\bInvoke-WebRequest/,
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

/** Check if a Read call is a full-file read (no limit/offset/path selector = likely analysis, not edit prep) */
export function isFullFileRead(input: Record<string, unknown> | undefined): boolean {
  if (!input) return true;
  return input.limit == null && input.offset == null && !hasEmbeddedReadSelector(input);
}

const READ_PATH_SELECTOR_RE = /:(?:raw|\d+(?:[-+]\d+)?|L\d+(?:-L?\d+|\+L?\d+)?)$/i;

function getReadPath(input: Record<string, unknown>): string | null {
  const path = input.path ?? input.file_path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function hasEmbeddedReadSelector(input: Record<string, unknown>): boolean {
  const path = getReadPath(input);
  return path != null && READ_PATH_SELECTOR_RE.test(path);
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
  const searchReplacement = getSearchReplacement(status);
  const shellSearchReplacement = getShellSearchReplacement(status);
  const fetchReplacement = status.tools.ctxFetchAndIndex ? "ctx_fetch_and_index" : null;
  const bashHttpReplacement = getBashHttpReplacement(status);

  // Search → block only when an active search/shell replacement exists.
  if (options.enforceRouting && toolName === "search" && searchReplacement) {
    return {
      block: true,
      reason: formatSearchReplacementReason(searchReplacement),
    };
  }

  // Find/Glob → block only when an active shell/search replacement exists.
  if (options.enforceRouting && toolName === "find" && shellSearchReplacement) {
    return {
      block: true,
      reason:
        shellSearchReplacement === "ctx_execute"
          ? 'Use ctx_execute(language: "shell", code: "find ...") or ctx_batch_execute instead of Find/Glob. Results are indexed and compressed to save context window.'
          : "Use ctx_batch_execute instead of Find/Glob. Results are indexed and compressed to save context window.",
    };
  }

  // Fetch/WebFetch → block only when ctx_fetch_and_index is active.
  if ((toolName === "fetch" || toolName === "web_fetch") && fetchReplacement) {
    return {
      block: true,
      reason:
        "Use ctx_fetch_and_index instead of Fetch/WebFetch. " +
        "It fetches the URL, indexes the content, and returns a compressed summary.",
    };
  }

  // Bash routing
  if (toolName === "bash") {
    const command = input?.command;

    // Bash search commands → block only when an active shell/search replacement exists.
    if (options.enforceRouting && isBashSearchCommand(command) && shellSearchReplacement) {
      return {
        block: true,
        reason:
          shellSearchReplacement === "ctx_execute"
            ? 'Use ctx_execute(language: "shell", code: "<command>") instead of Bash for search commands. For multiple commands, use ctx_batch_execute. Results stay in sandbox and are auto-indexed.'
            : "Use ctx_batch_execute instead of Bash for search commands. Results stay in sandbox and are auto-indexed.",
      };
    }

    // Bash HTTP commands → block only when an active HTTP replacement exists.
    if (options.blockHttpCommands && isHttpCommand(command) && bashHttpReplacement) {
      return {
        block: true,
        reason: formatBashHttpReplacementReason(bashHttpReplacement),
      };
    }
  }

  return undefined;
}

function getSearchReplacement(status: ContextModeStatus): "ctx_search" | "ctx_batch_execute" | "ctx_execute" | null {
  if (status.tools.ctxSearch) return "ctx_search";
  if (status.tools.ctxBatchExecute) return "ctx_batch_execute";
  if (status.tools.ctxExecute) return "ctx_execute";
  return null;
}

function getShellSearchReplacement(status: ContextModeStatus): "ctx_execute" | "ctx_batch_execute" | null {
  if (status.tools.ctxExecute) return "ctx_execute";
  if (status.tools.ctxBatchExecute) return "ctx_batch_execute";
  return null;
}

function getBashHttpReplacement(status: ContextModeStatus): "ctx_fetch_and_index" | "ctx_execute" | null {
  if (status.tools.ctxFetchAndIndex) return "ctx_fetch_and_index";
  if (status.tools.ctxExecute) return "ctx_execute";
  return null;
}

/**
 * Native host tools that are fully shadowed by an active ctx_* replacement.
 *
 * When `enforceRouting` is on, these tools should be hidden from the model's
 * active tool catalog (via `setActiveTools`) so the LLM never tries to call
 * them only to receive a routing-block error. The `routeToolCall` runtime
 * block remains as a safety net for hosts that cannot filter the tool list.
 *
 * Bash is intentionally NOT included: it is needed for non-search shell work,
 * and `routeToolCall` already blocks only the search/HTTP subset.
 */
export function getShadowedNativeTools(status: ContextModeStatus): string[] {
  const shadowed: string[] = [];
  if (getSearchReplacement(status)) shadowed.push("search");
  if (getShellSearchReplacement(status)) shadowed.push("find");
  if (status.tools.ctxFetchAndIndex) {
    shadowed.push("fetch", "web_fetch");
  }
  return shadowed;
}

function formatSearchReplacementReason(replacement: "ctx_search" | "ctx_batch_execute" | "ctx_execute"): string {
  if (replacement === "ctx_search") {
    return 'Use active ctx_search(queries: ["<pattern>"]) instead of Search. Results are indexed and compressed to save context window.';
  }
  if (replacement === "ctx_batch_execute") {
    return "Use active ctx_batch_execute instead of Search. Results are indexed and compressed to save context window.";
  }
  return 'Use active ctx_execute(language: "shell", code: "grep ...") instead of Search. Results stay in sandbox to save context window.';
}

function formatBashHttpReplacementReason(replacement: "ctx_fetch_and_index" | "ctx_execute"): string {
  if (replacement === "ctx_fetch_and_index") {
    return (
      "Use ctx_fetch_and_index instead of curl/wget. " +
      "It fetches the URL, indexes the content, and returns a compressed summary."
    );
  }
  return 'Use ctx_execute(language: "shell", code: "<http request>") instead of Bash HTTP commands. Only printed summaries enter context.';
}