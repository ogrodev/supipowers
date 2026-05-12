import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { Platform, PlatformPaths } from "../platform/types.js";
import type { SupipowersConfig } from "../types.js";
import { createMempalaceBridge, type MempalaceBridgeFacade } from "./bridge.js";
import { resolveDefaultWing, resolveMempalaceConfig } from "./config.js";
import {
  resolveInstalledBridgeScriptPath,
  resolveManagedVenvPaths,
  setupMempalaceRuntime,
  type ProcessRunner,
  type SetupMempalaceRuntimeResult,
} from "./runtime.js";

export interface MempalaceInstallSnapshot {
  enabled: boolean;
  packageVersion: string;
  managedBinDir: string;
  uvPath: string;
  uvInstalled: boolean;
  venvPath: string;
  venvPython: string;
  venvInstalled: boolean;
  bridgeOk: boolean;
  bridgePath: string;
  /** True when uv binary, managed venv, and bridge script are all present. */
  ready: boolean;
}

/**
 * Inspect the filesystem for the artifacts MemPalace setup writes.
 *
 * Cheap (no subprocesses, no network); safe to call from interactive prompts to
 * decide whether to phrase the question as "Install" vs "Update".
 */
export function snapshotMempalaceInstall(
  paths: PlatformPaths,
  cwd: string,
  config: SupipowersConfig = DEFAULT_CONFIG,
): MempalaceInstallSnapshot {
  const resolved = resolveMempalaceConfig(config, cwd, paths);
  const venv = resolveManagedVenvPaths(resolved.managedVenvPath);
  const managedBinDir = paths.global("bin");
  const uvBinary = process.platform === "win32" ? "uv.exe" : "uv";
  const uvPath = path.join(managedBinDir, uvBinary);
  const bridge = resolveInstalledBridgeScriptPath(paths);

  const uvInstalled = existsSync(uvPath);
  const venvInstalled = existsSync(venv.python);

  return {
    enabled: resolved.enabled,
    packageVersion: resolved.packageVersion,
    managedBinDir,
    uvPath,
    uvInstalled,
    venvPath: venv.root,
    venvPython: venv.python,
    venvInstalled,
    bridgeOk: bridge.ok,
    bridgePath: bridge.path,
    ready: uvInstalled && venvInstalled && bridge.ok,
  };
}

export interface RunMempalaceSetupOptions {
  paths: PlatformPaths;
  cwd: string;
  config?: SupipowersConfig;
  runner: ProcessRunner;
  onProgress?: (message: string) => void;
}

/**
 * Drive the MemPalace install/update pipeline using the same managed paths every
 * caller (the `/supi:memory setup` command, the `bunx supipowers` installer, and
 * the `/supi:update` command) should agree on.
 *
 * Returns the structured result from `setupMempalaceRuntime`. Callers decide how
 * to surface progress and errors (spinner vs. notify vs. raw stdout).
 */
export async function runMempalaceSetup(
  options: RunMempalaceSetupOptions,
): Promise<SetupMempalaceRuntimeResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const resolved = resolveMempalaceConfig(config, options.cwd, options.paths);
  const bridge = resolveInstalledBridgeScriptPath(options.paths);
  if (!bridge.ok) {
    return { ok: false, error: bridge.error };
  }
  return await setupMempalaceRuntime({
    cwd: options.cwd,
    config: resolved,
    bridgeScriptPath: bridge.path,
    managedBinDir: options.paths.global("bin"),
    runner: options.runner,
    onProgress: options.onProgress,
  });
}

export interface MempalaceInitState {
  wing: string;
  initialized: boolean;
  /** Set when the bridge call failed (palace missing, timeout, etc.); treat as not-initialized. */
  bridgeError?: { code: string; message: string };
}

function isWingPresent(result: unknown, wing: string): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;

  // tool_list_wings returns `{ wings: { <name>: <count>, ... } }`. The
  // dict shape is the canonical one from mempalace.mcp_server. Older
  // / partial responses may carry array shapes (items/results), so we
  // accept both rather than coupling tightly.
  const wings = record.wings;
  if (wings && typeof wings === "object" && !Array.isArray(wings)) {
    if (Object.prototype.hasOwnProperty.call(wings, wing)) return true;
  }

  const candidates = [record.wings, record.items, record.results];
  for (const list of candidates) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === "string" && entry === wing) return true;
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (e.name === wing || e.wing === wing || e.id === wing) return true;
      }
    }
  }
  return false;
}

/**
 * Determine whether the current project's wing has been registered in the palace.
 *
 * Calls `list_wings` through the bridge facade and looks for the resolved default
 * wing in the response. On any failure (palace missing, timeout, malformed
 * response) the wing is treated as not initialized — the steered init step is
 * idempotent on already-initialized wings, so a false negative is safe.
 */
export async function checkMempalaceProjectInitialized(options: {
  paths: PlatformPaths;
  cwd: string;
  config?: SupipowersConfig;
  bridge?: MempalaceBridgeFacade;
}): Promise<MempalaceInitState> {
  const config = options.config ?? DEFAULT_CONFIG;
  const resolved = resolveMempalaceConfig(config, options.cwd, options.paths);
  let wing: string;
  try {
    wing = resolveDefaultWing(resolved, options.cwd, options.paths);
  } catch {
    wing = "project";
  }
  const bridge = options.bridge ?? createMempalaceBridge({
    cwd: options.cwd,
    config: resolved,
    runtime: { resolveBridgeScriptPath: () => resolveInstalledBridgeScriptPath(options.paths) },
  });
  const result = await bridge.execute({ action: "list_wings" });
  if (!result.ok) {
    return {
      wing,
      initialized: false,
      bridgeError: { code: result.error.code, message: result.error.message },
    };
  }
  return { wing, initialized: isWingPresent(result.result, wing) };
}

/**
 * Steer the active model toward initializing the project's MemPalace wing.
 *
 * Caller should only invoke this after `setupMempalaceRuntime` succeeded and
 * `checkMempalaceProjectInitialized` returned `initialized: false`. Returns
 * `false` when steering is unavailable (no `sendMessage` on the platform).
 */
export function steerMempalaceInitialization(
  platform: Platform,
  state: { wing: string; cwd: string },
): boolean {
  if (typeof platform.sendMessage !== "function") return false;
  const text = [
    "# MemPalace memory: initialize project wing",
    "",
    `MemPalace setup just completed. The current project's wing (\`${state.wing}\`) is not yet initialized in the palace.`,
    "",
    "Please initialize and seed memory for this project by running these tool calls in order:",
    "",
    `1. \`mempalace(action="init", dir=".", yes=true, timeout=30)\` — register this project's wing in the palace.`,
    `2. \`mempalace(action="mine", dir=".", limit=20, timeout=30)\` — seed initial drawers from project files.`,
    "",
    "Step 2 is recommended but optional; skip it if the user prefers an empty wing or is mid-task. After running, summarize what was indexed.",
  ].join("\n");

  platform.sendMessage(
    {
      customType: "supi-mempalace-init",
      content: [{ type: "text", text }],
      display: "none",
    },
    { deliverAs: "steer", triggerTurn: true },
  );
  return true;
}
