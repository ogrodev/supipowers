// src/context-mode/detector.ts

/** Which supi-context-mode MCP tools are available in the current session */
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
 * Check if a tool name matches a supi-context-mode tool suffix.
 * Handles multiple naming conventions:
 *   - Bare names: "ctx_execute"
 *   - Claude Code MCP: "mcp__plugin_context-mode_context-mode__ctx_execute"
 *   - OMP MCP (new): "mcp_supi_context_mode_ctx_execute"
 *   - OMP MCP (legacy): "mcp_context_mode_ctx_execute"
 *
 * We match by checking if the tool contains a known supi-context-mode server
 * prefix followed by the suffix, or is the bare suffix itself.
 */
const CONTEXT_MODE_PREFIXES = [
  "mcp__plugin_context-mode_context-mode__",  // Claude Code
  "mcp_supi_context_mode_",                   // OMP (current)
  "mcp_context_mode_",                        // OMP (legacy, backward compat)
];

function matchesSuffix(tool: string, suffix: string): boolean {
  if (tool === suffix) return true;
  for (const prefix of CONTEXT_MODE_PREFIXES) {
    if (tool === prefix + suffix) return true;
  }
  return false;
}

/** Detect supi-context-mode MCP tool availability from the active tools list */
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
    for (const [suffix, key] of TOOL_SUFFIXES) {
      if (matchesSuffix(tool, suffix)) {
        tools[key] = true;
        break;
      }
    }
  }

  const available = Object.values(tools).some(Boolean);
  return { available, tools };
}
