import type { Platform } from "../platform/types.js";
import type { SupipowersConfig } from "../types.js";
import { createMempalaceBridge, type MempalaceBridgeFacade } from "./bridge.js";
import { resolveMempalaceConfig, type ResolvedMempalaceConfig } from "./config.js";
import { formatMempalaceError, formatMempalaceResult } from "./format.js";
import { mempalaceToolParameters, validateMempalaceParams, type MempalaceParams } from "./schema.js";
import {
  resolveInstalledBridgeScriptPath,
  setupMempalaceRuntime,
  type BridgePathResult,
  type SetupMempalaceRuntimeOptions,
  type SetupMempalaceRuntimeResult,
} from "./runtime.js";
import {
  snapshotMempalaceInstall,
  type MempalaceInstallSnapshot,
} from "./installer-helper.js";

export interface MempalaceToolDeps {
  createBridge?: (config: ResolvedMempalaceConfig, cwd: string) => MempalaceBridgeFacade;
  resolveBridgeScriptPath?: () => BridgePathResult;
  setupRuntime?: (options: SetupMempalaceRuntimeOptions) => Promise<SetupMempalaceRuntimeResult>;
  /**
   * Installation readiness probe. Default reads the filesystem; tests can inject
   * a stub. The tool is registered only when this returns `ready: true`.
   */
  snapshotInstall?: (config: SupipowersConfig, cwd: string) => MempalaceInstallSnapshot;
}

function toolResult(text: string, details: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details };
}

function readCwd(toolCtx: unknown): string {
  if (typeof toolCtx === "object" && toolCtx !== null && typeof (toolCtx as { cwd?: unknown }).cwd === "string") {
    return (toolCtx as { cwd: string }).cwd;
  }
  return process.cwd();
}

function emitProgress(onUpdate: unknown, text: string): void {
  if (typeof onUpdate !== "function") return;
  // OMP's tool runtime treats the value passed to onUpdate as a partial tool
  // result. It iterates `partialResult.content.map(...)`, so we must pass a
  // shape that mirrors the final `{ content: [...] }` return.
  try {
    onUpdate({ content: [{ type: "text", text }] });
  } catch {
    // best effort — never let a progress notification kill the tool call
  }
}

async function executeSetup(
  params: MempalaceParams,
  resolved: ResolvedMempalaceConfig,
  cwd: string,
  managedBinDir: string,
  defaultResolveBridgeScriptPath: () => BridgePathResult,
  deps: MempalaceToolDeps,
  onUpdate: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const bridgePath = (deps.resolveBridgeScriptPath ?? defaultResolveBridgeScriptPath)();
  if (!bridgePath.ok) {
    const formatted = formatMempalaceError(bridgePath.error, {
      ok: false,
      action: params.action,
      bridgeScriptPath: bridgePath.path,
    });
    return toolResult(formatted.text, formatted.details as Record<string, unknown>);
  }

  const setup = await (deps.setupRuntime ?? setupMempalaceRuntime)({
    cwd,
    config: resolved,
    bridgeScriptPath: bridgePath.path,
    managedBinDir,
    onProgress: (message) => emitProgress(onUpdate, message),
  });

  if (!setup.ok) {
    const formatted = formatMempalaceError(setup.error, {
      ok: false,
      action: "setup",
      stderrTail: setup.stderrTail,
    });
    return toolResult(formatted.text, formatted.details as Record<string, unknown>);
  }

  const formatted = formatMempalaceResult(
    "setup",
    { message: "setup complete", ...setup.details },
    resolved.budgets,
  );
  return toolResult(formatted.text, {
    ok: true,
    action: "setup",
    setup: setup.details,
  });
}

export function registerMempalaceTool(
  platform: Platform,
  config: SupipowersConfig,
  deps: MempalaceToolDeps = {},
): void {
  if (!config.mempalace.enabled) return;
  if (typeof platform.registerTool !== "function") return;

  // Gate exposure on installation readiness. Without uv + the managed venv +
  // the Python bridge script all present, every action fails — surfacing a
  // dead tool in the agent's catalog only invites broken tool calls. Setup is
  // driven explicitly by `/supi:memory setup`, so this gate is recoverable.
  const snapshotFn = deps.snapshotInstall ?? ((cfg, cwd) => snapshotMempalaceInstall(platform.paths, cwd, cfg));
  let snapshot: MempalaceInstallSnapshot;
  try {
    snapshot = snapshotFn(config, process.cwd());
  } catch (error) {
    (platform as { logger?: { warn?: (message: string, error?: unknown) => void } }).logger?.warn?.(
      "supi-mempalace: install snapshot failed; tool will not be registered",
      error,
    );
    return;
  }
  if (!snapshot.ready) return;
  const bridgeRuntime = {
    resolveBridgeScriptPath: () => resolveInstalledBridgeScriptPath(platform.paths),
  };


  platform.registerTool({
    name: "mempalace",
    label: "MemPalace",
    description:
      "MemPalace memory dispatcher. **MUST** call `search` before answering past-fact questions; write only on explicit user request.",
    parameters: mempalaceToolParameters,
    async execute(_toolCallId: string, rawParams: unknown, _signal: AbortSignal, onUpdate: unknown, toolCtx: unknown) {
      try {
        const validation = validateMempalaceParams(rawParams);
        if (!validation.valid || !validation.params) {
          return toolResult(`MemPalace validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`, {
            ok: false,
            errors: validation.errors,
          });
        }

        const cwd = readCwd(toolCtx);
        const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
        const params = validation.params;

        if (params.action === "setup") {
          return await executeSetup(
            params,
            resolved,
            cwd,
            platform.paths.global("bin"),
            bridgeRuntime.resolveBridgeScriptPath,
            deps,
            onUpdate,
          );
        }

        const bridge = deps.createBridge
          ? deps.createBridge(resolved, cwd)
          : createMempalaceBridge({ cwd, config: resolved, runtime: bridgeRuntime });
        const result = await bridge.execute(params);

        if (!result.ok) {
          const formatted = formatMempalaceError(result.error, {
            ok: false,
            action: result.action,
            diagnostics: result.diagnostics,
          });
          return toolResult(formatted.text, {
            ok: false,
            action: result.action,
            error: result.error,
            diagnostics: result.diagnostics,
          });
        }

        const formatted = formatMempalaceResult(result.action, result.result, resolved.budgets);
        return toolResult(formatted.text, {
          ok: true,
          action: result.action,
          result: result.result,
          diagnostics: result.diagnostics,
          formattedDetails: formatted.details,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        return toolResult(
          `MemPalace tool crashed: ${message}`,
          { ok: false, error: { code: "tool_crash", message, stack } },
        );
      }
    },
  });
}
