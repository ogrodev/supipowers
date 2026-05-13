export const CONTEXT_MODE_TOOL_NAMES = [
  "ctx_execute",
  "ctx_execute_file",
  "ctx_batch_execute",
  "ctx_index",
  "ctx_search",
  "ctx_open_cached",
  "ctx_fetch_and_index",
  "ctx_stats",
  "ctx_purge",
  "ctx_repomap",
  "ctx_symbol",
] as const;

export type ContextModeToolName = (typeof CONTEXT_MODE_TOOL_NAMES)[number];

export const OWNED_TOOL_PRIORITY = [
  "ctx_execute",
  "ctx_search",
  "ctx_open_cached",
  "ctx_batch_execute",
  "ctx_execute_file",
  "ctx_fetch_and_index",
  "ctx_index",
  "ctx_stats",
  "ctx_purge",
  "ctx_repomap",
  "ctx_symbol",
] as const;

const CONTEXT_MODE_TOOL_SET = new Set<string>(CONTEXT_MODE_TOOL_NAMES);
const OWNED_PRIORITY_INDEX = new Map<string, number>(
  OWNED_TOOL_PRIORITY.map((name, index) => [name, index]),
);

export const BALANCED_KEYWORD_TOOLS: Record<string, string[]> = {
  search: ["ctx_batch_execute"],
  grep: ["ctx_batch_execute"],
  find: ["ctx_batch_execute"],
  scan: ["ctx_batch_execute"],
  inspect: ["ctx_batch_execute"],
  explore: ["ctx_batch_execute"],
  "analyze repo": ["ctx_batch_execute"],
  "project-wide": ["ctx_batch_execute"],
  todo: ["ctx_batch_execute"],
  references: ["ctx_batch_execute"],
  "large file": ["ctx_execute_file"],
  "summarize file": ["ctx_execute_file"],
  "extract from file": ["ctx_execute_file"],
  "process file without reading": ["ctx_execute_file"],
  http: ["ctx_fetch_and_index"],
  https: ["ctx_fetch_and_index"],
  curl: ["ctx_fetch_and_index"],
  wget: ["ctx_fetch_and_index"],
  "fetch docs": ["ctx_fetch_and_index"],
  "web page": ["ctx_fetch_and_index"],
  "index this": ["ctx_index"],
  "store in knowledge": ["ctx_index"],
  "make searchable": ["ctx_index"],
  "context stats": ["ctx_stats"],
  "token usage": ["ctx_stats"],
  savings: ["ctx_stats"],
  "ctx stats": ["ctx_stats"],
  "ctx purge": ["ctx_purge"],
  "purge knowledge": ["ctx_purge"],
  "reset knowledge index": ["ctx_purge"],
  "open cached": ["ctx_open_cached"],
  "cached handle": ["ctx_open_cached"],
  ctx_open_cached: ["ctx_open_cached"],
  repomap: ["ctx_repomap"],
  "repo map": ["ctx_repomap"],
  symbol: ["ctx_symbol"],
  symbols: ["ctx_symbol"],
};

export function isContextModeTool(name: string): boolean {
  return CONTEXT_MODE_TOOL_SET.has(name);
}

export function isSupiOwnedTool(name: string): boolean {
  return isContextModeTool(name);
}

export function orderOwnedTools(names: Iterable<string>): string[] {
  return [...new Set([...names].filter(isSupiOwnedTool))].sort((a, b) => {
    const aPriority = OWNED_PRIORITY_INDEX.get(a);
    const bPriority = OWNED_PRIORITY_INDEX.get(b);

    if (aPriority !== undefined && bPriority !== undefined) return aPriority - bPriority;
    if (aPriority !== undefined) return -1;
    if (bPriority !== undefined) return 1;
    return a.localeCompare(b);
  });
}
