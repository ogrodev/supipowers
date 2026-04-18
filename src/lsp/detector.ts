// src/lsp/detector.ts
import { findExecutable } from "../utils/executable.js";
import { LSP_SERVERS, type LspServerEntry } from "./setup-guide.js";

export interface LspServerStatus {
  server: LspServerEntry;
  installed: boolean;
}

/**
 * Check which LSP servers are installed by looking for their binaries on PATH.
 */
export async function checkInstalledServers(
  _exec: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>,
  resolveExecutable: (command: string) => string | null = (command) => findExecutable(command),
): Promise<LspServerStatus[]> {
  return LSP_SERVERS.map((server) => ({
    server,
    installed: resolveExecutable(server.server) !== null,
  }));
}

/**
 * Check if LSP is available from the OMP extension context at runtime.
 * Reads the active tools list to see if "lsp" is registered.
 */
export function isLspAvailable(activeTools: string[]): boolean {
  return activeTools.includes("lsp");
}
