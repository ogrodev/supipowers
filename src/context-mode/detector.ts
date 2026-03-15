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

const TOOL_MAP: Record<string, keyof ContextModeStatus["tools"]> = {
  ctx_execute: "ctxExecute",
  ctx_batch_execute: "ctxBatchExecute",
  ctx_execute_file: "ctxExecuteFile",
  ctx_index: "ctxIndex",
  ctx_search: "ctxSearch",
  ctx_fetch_and_index: "ctxFetchAndIndex",
};

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
    const key = TOOL_MAP[tool];
    if (key) tools[key] = true;
  }

  const available = Object.values(tools).some(Boolean);
  return { available, tools };
}
