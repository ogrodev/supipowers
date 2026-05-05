// src/context-mode/detector.ts

/** Which context-mode tools are available in the current session */
export interface ContextModeStatus {
  available: boolean;
  tools: {
    ctxExecute: boolean;
    ctxBatchExecute: boolean;
    ctxExecuteFile: boolean;
    ctxIndex: boolean;
    ctxSearch: boolean;
    ctxFetchAndIndex: boolean;
    ctxOpenCached: boolean;
    ctxStats: boolean;
    ctxPurge: boolean;
    ctxRepomap: boolean;
    ctxSymbol: boolean;
  };
}

/**
 * Return active context-mode tool status. When activeTools is supplied, it is
 * treated as the current model-visible tool set. Without it, keep the legacy
 * registered-tool fallback for compatibility with older call sites.
 */
export function detectContextMode(activeTools?: string[]): ContextModeStatus {
  if (activeTools) {
    const active = new Set(activeTools);
    const tools = {
      ctxExecute: active.has("ctx_execute"),
      ctxBatchExecute: active.has("ctx_batch_execute"),
      ctxExecuteFile: active.has("ctx_execute_file"),
      ctxIndex: active.has("ctx_index"),
      ctxSearch: active.has("ctx_search"),
      ctxFetchAndIndex: active.has("ctx_fetch_and_index"),
      ctxOpenCached: active.has("ctx_open_cached"),
      ctxStats: active.has("ctx_stats"),
      ctxPurge: active.has("ctx_purge"),
      ctxRepomap: active.has("ctx_repomap"),
      ctxSymbol: active.has("ctx_symbol"),
    };
    return {
      available: Object.values(tools).some(Boolean),
      tools,
    };
  }

  return {
    available: true,
    tools: {
      ctxExecute: true,
      ctxBatchExecute: true,
      ctxExecuteFile: true,
      ctxIndex: true,
      ctxSearch: true,
      ctxFetchAndIndex: true,
      ctxOpenCached: true,
      ctxStats: true,
      ctxPurge: true,
      ctxRepomap: true,
      ctxSymbol: true,
    },
  };
}