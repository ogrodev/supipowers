// src/lsp/detector.ts
import { LSP_SERVERS, type LspServerEntry } from "./setup-guide.js";

export interface LspServerStatus {
  server: LspServerEntry;
  installed: boolean;
}

/**
 * Check which LSP servers are installed by looking for their binaries.
 */
export async function checkInstalledServers(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>
): Promise<LspServerStatus[]> {
  const results: LspServerStatus[] = [];
  for (const server of LSP_SERVERS) {
    try {
      const result = await exec("which", [server.server]);
      results.push({ server, installed: result.code === 0 });
    } catch {
      results.push({ server, installed: false });
    }
  }
  return results;
}

/**
 * Check if LSP is available from the OMP extension context at runtime.
 * Reads the active tools list to see if "lsp" is registered.
 */
export function isLspAvailable(activeTools: string[]): boolean {
  return activeTools.includes("lsp");
}
