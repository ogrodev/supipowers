// src/context-mode/installer.ts
import { detectContextMode } from "./detector.js";
import { DEPENDENCIES, installDep } from "../deps/registry.js";
import type { ExecResult } from "../platform/types.js";

type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

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
  const dep = DEPENDENCIES.find((d) => d.binary === "context-mode");
  const check = dep ? await dep.checkFn(exec) : { installed: false };

  return {
    cliInstalled: check.installed,
    mcpConfigured: status.available,
    toolsAvailable: status.available,
    version: check.version ?? null,
  };
}

/** Install context-mode globally */
export async function installContextMode(
  exec: ExecFn,
): Promise<{ success: boolean; error?: string }> {
  return installDep(exec, "context-mode");
}
