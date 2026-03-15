// src/context-mode/installer.ts
import { detectContextMode } from "./detector.js";

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

/** Installation status */
export interface ContextModeInstallStatus {
  cliInstalled: boolean;
  mcpConfigured: boolean;
  toolsAvailable: boolean;
  version: string | null;
}

/** Check context-mode installation status */
export async function checkInstallation(
  exec: ExecFn,
  activeTools: string[],
): Promise<ContextModeInstallStatus> {
  const status = detectContextMode(activeTools);

  // Check CLI
  let cliInstalled = false;
  let version: string | null = null;

  try {
    const whichResult = await exec("which", ["context-mode"]);
    cliInstalled = whichResult.code === 0;
  } catch {
    cliInstalled = false;
  }

  // Get version
  if (cliInstalled) {
    try {
      const versionResult = await exec("context-mode", ["--version"]);
      if (versionResult.code === 0) {
        version = versionResult.stdout.trim() || null;
      }
    } catch {
      version = null;
    }
  }

  return {
    cliInstalled,
    mcpConfigured: status.available,
    toolsAvailable: status.available,
    version,
  };
}

/** Install context-mode globally */
export async function installContextMode(
  exec: ExecFn,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await exec("npm", ["install", "-g", "context-mode"]);
    if (result.code !== 0) {
      return {
        success: false,
        error: `npm install failed (exit ${result.code}). Check permissions or try: sudo npm install -g context-mode`,
      };
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: `Installation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
