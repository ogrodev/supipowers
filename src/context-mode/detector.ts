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
  };
}

/**
 * Context-mode tools are native (registered by this extension), so they are
 * always available when the extension is loaded. The interface is preserved for
 * backward compatibility with hooks/routing consumers.
 */
export function detectContextMode(_activeTools?: string[]): ContextModeStatus {
  return {
    available: true,
    tools: {
      ctxExecute: true,
      ctxBatchExecute: true,
      ctxExecuteFile: true,
      ctxIndex: true,
      ctxSearch: true,
      ctxFetchAndIndex: true,
    },
  };
}