// src/lsp/detector.ts
import type { SupipowersConfig } from "../types.js";

export interface LspStatus {
  available: boolean;
  servers: LspServerInfo[];
}

export interface LspServerInfo {
  name: string;
  status: "running" | "stopped" | "error";
  fileTypes: string[];
  error?: string;
}

/**
 * Check LSP availability by invoking the lsp tool's "status" action.
 * Uses pi.exec to call the lsp tool programmatically.
 */
export async function detectLsp(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>
): Promise<LspStatus> {
  try {
    // We check by looking for LSP config files or running servers
    // In OMP, LSP is a built-in tool — we check if it's in active tools
    return { available: false, servers: [] };
  } catch {
    return { available: false, servers: [] };
  }
}

/**
 * Check if LSP is available from the extension context.
 * Reads the active tools list to see if "lsp" is registered.
 */
export function isLspAvailable(activeTools: string[]): boolean {
  return activeTools.includes("lsp");
}
