import type { ResolvedMempalaceConfig } from "./config.js";
import type { MempalaceParams } from "./schema.js";
import {
  resolveBridgeScriptPath,
  resolveManagedVenvPaths,
  runBridgeRequest,
  type BridgePathResult,
  type MempalaceRuntimeError,
  type RunBridgeRequestOptions,
  type RunBridgeRequestResult,
} from "./runtime.js";

export type MempalaceBridgeCallResult =
  | {
      ok: true;
      action: MempalaceParams["action"];
      result: unknown;
      diagnostics: Record<string, unknown>;
    }
  | {
      ok: false;
      action: MempalaceParams["action"];
      error: MempalaceRuntimeError;
      diagnostics: Record<string, unknown>;
    };

export interface MempalaceBridgeRuntimeDeps {
  resolveBridgeScriptPath?: () => BridgePathResult;
  runBridgeRequest?: (options: RunBridgeRequestOptions) => Promise<RunBridgeRequestResult>;
}

export interface CreateMempalaceBridgeOptions {
  cwd: string;
  config: ResolvedMempalaceConfig;
  runtime?: MempalaceBridgeRuntimeDeps;
}

export interface MempalaceBridgeFacade {
  execute(params: MempalaceParams): Promise<MempalaceBridgeCallResult>;
}

function withSetupRemediation(error: MempalaceRuntimeError): MempalaceRuntimeError {
  if (error.remediation) return error;
  if (error.code === "mempalace_missing" || error.code === "bridge_process_failed") {
    return {
      ...error,
      remediation: "Call mempalace(action=\"setup\") first, then retry the requested MemPalace action.",
    };
  }
  return error;
}

function mergeDiagnostics(...parts: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  return Object.assign({}, ...parts.filter(Boolean));
}

export function createMempalaceBridge(options: CreateMempalaceBridgeOptions): MempalaceBridgeFacade {
  const resolveBridge = options.runtime?.resolveBridgeScriptPath ?? (() => resolveBridgeScriptPath());
  const runBridge = options.runtime?.runBridgeRequest ?? runBridgeRequest;

  return {
    async execute(params: MempalaceParams): Promise<MempalaceBridgeCallResult> {
      const bridgePath = resolveBridge();
      if (!bridgePath.ok) {
        return {
          ok: false,
          action: params.action,
          error: bridgePath.error,
          diagnostics: { bridgeScriptPath: bridgePath.path },
        };
      }

      const venv = resolveManagedVenvPaths(options.config.managedVenvPath);
      const timeoutMs = typeof params.timeout === "number"
        ? Math.min(params.timeout, options.config.timeouts.bridgeMs)
        : options.config.timeouts.bridgeMs;
      const palacePath = params.palace ?? options.config.palacePath;
      const runResult = await runBridge({
        pythonPath: venv.python,
        bridgeScriptPath: bridgePath.path,
        timeoutMs,
        request: {
          action: params.action,
          params: { ...params },
          options: {
            cwd: options.cwd,
            palacePath,
            agentName: options.config.defaultAgentName,
          },
        },
      });

      if (!runResult.ok) {
        return {
          ok: false,
          action: params.action,
          error: withSetupRemediation(runResult.error),
          diagnostics: {
            durationMs: runResult.durationMs,
            stdoutPreview: runResult.stdoutPreview,
            stderrTail: runResult.stderrTail,
          },
        };
      }

      if (!runResult.response.ok) {
        return {
          ok: false,
          action: params.action,
          error: withSetupRemediation(runResult.response.error),
          diagnostics: mergeDiagnostics(runResult.response.diagnostics, {
            durationMs: runResult.durationMs,
            stderr: runResult.stderr,
          }),
        };
      }

      return {
        ok: true,
        action: params.action,
        result: runResult.response.result ?? {},
        diagnostics: mergeDiagnostics(runResult.response.diagnostics, {
          durationMs: runResult.durationMs,
          stderr: runResult.stderr,
        }),
      };
    },
  };
}
