// src/context-mode/detector.ts

/** Which context-mode MCP tools are available in the current session */
export interface ContextModeStatus {
  available: boolean;
  tools: {
    ctxExecute: boolean;
    ctxBatchExecute: boolean;
    ctxExecuteFile: boolean;
    ctxIndex: boolean;
    ctxSearch: boolean;
    ctxFetchAndIndex: boolean;
  };
}

/** Suffixes to match against full MCP-namespaced tool names */
const TOOL_SUFFIXES: Array<[string, keyof ContextModeStatus["tools"]]> = [
  ["ctx_execute", "ctxExecute"],
  ["ctx_batch_execute", "ctxBatchExecute"],
  ["ctx_execute_file", "ctxExecuteFile"],
  ["ctx_index", "ctxIndex"],
  ["ctx_search", "ctxSearch"],
  ["ctx_fetch_and_index", "ctxFetchAndIndex"],
];

/**
 * Extract the short tool name from a potentially MCP-namespaced tool name.
 * MCP tools use the format: mcp__<server>__<tool_name>
 * Native tools use bare names like: lsp, bash, etc.
 */
function getShortName(tool: string): string {
  const lastSep = tool.lastIndexOf("__");
  return lastSep >= 0 ? tool.slice(lastSep + 2) : tool;
}

/** Detect context-mode MCP tool availability from the active tools list */
export function detectContextMode(activeTools: string[]): ContextModeStatus {
  const tools: ContextModeStatus["tools"] = {
    ctxExecute: false,
    ctxBatchExecute: false,
    ctxExecuteFile: false,
    ctxIndex: false,
    ctxSearch: false,
    ctxFetchAndIndex: false,
  };

  for (const tool of activeTools) {
    const shortName = getShortName(tool);
    for (const [suffix, key] of TOOL_SUFFIXES) {
      if (shortName === suffix) {
        tools[key] = true;
        break;
      }
    }
  }

  const available = Object.values(tools).some(Boolean);
  return { available, tools };
}
