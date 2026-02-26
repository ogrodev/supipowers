import { randomUUID } from "node:crypto";
import { chooseAdapter, type AdapterChoice, type ExecutionCapabilities } from "./capability-detector";
import { executeAntColonyAdapter, type AntColonyExecutionResult } from "./ant-colony-adapter";
import { executeNativeAdapter, type NativeExecutionResult } from "./native-adapter";
import { executeSubagentAdapter, type SubagentExecutionResult } from "./subagent-adapter";
import { parsePlanSteps } from "../execution/plan-steps";
import type { ExecutionProgressUpdate } from "../execution/progress";
import { appendExecutionEvent } from "../storage/execution-history";

export interface RouterExecutionParams {
  cwd: string;
  objective?: string;
  planArtifactPath?: string;
  batchSize?: number;
  capabilities?: ExecutionCapabilities;
  onProgress?: (update: ExecutionProgressUpdate) => void;
}

export type RoutedExecutionResult = NativeExecutionResult | SubagentExecutionResult | AntColonyExecutionResult;

const activeRunsByCwd = new Map<string, { runId: string; controller: AbortController }>();

export function getActiveRun(cwd: string): string | undefined {
  return activeRunsByCwd.get(cwd)?.runId;
}

export function stopActiveRun(cwd: string): { stopped: boolean; runId?: string } {
  const active = activeRunsByCwd.get(cwd);
  if (!active) return { stopped: false };

  active.controller.abort();
  return { stopped: true, runId: active.runId };
}

async function runWithAdapter(
  adapter: AdapterChoice,
  params: RouterExecutionParams,
  runId: string,
  signal: AbortSignal,
): Promise<RoutedExecutionResult> {
  if (adapter === "ant_colony") {
    return executeAntColonyAdapter({
      cwd: params.cwd,
      runId,
      objective: params.objective,
      planArtifactPath: params.planArtifactPath,
      signal,
      onProgress: params.onProgress,
    });
  }

  if (adapter === "subagent") {
    return executeSubagentAdapter({
      cwd: params.cwd,
      runId,
      objective: params.objective,
      planArtifactPath: params.planArtifactPath,
      mode: "auto",
      signal,
      onProgress: params.onProgress,
    });
  }

  return executeNativeAdapter({
    cwd: params.cwd,
    runId,
    objective: params.objective,
    planArtifactPath: params.planArtifactPath,
    batchSize: params.batchSize,
    signal,
    onProgress: params.onProgress,
  });
}

function fallbackSequence(primary: AdapterChoice, capabilities: ExecutionCapabilities): AdapterChoice[] {
  const sequence: AdapterChoice[] = [primary];

  if (primary !== "ant_colony" && capabilities.antColony) sequence.push("ant_colony");
  if (primary !== "subagent" && capabilities.subagent) sequence.push("subagent");
  if (primary !== "native") sequence.push("native");

  return sequence;
}

export async function executeWithRouter(params: RouterExecutionParams): Promise<RoutedExecutionResult> {
  if (activeRunsByCwd.has(params.cwd)) {
    throw new Error("An execution run is already active in this workspace.");
  }

  const runId = randomUUID();
  const controller = new AbortController();
  activeRunsByCwd.set(params.cwd, { runId, controller });

  const capabilities = params.capabilities ?? {
    subagent: false,
    antColony: false,
    antColonyStatus: false,
    native: true,
  };

  const stepCount = parsePlanSteps(params.planArtifactPath).length;
  const primaryAdapter = chooseAdapter(capabilities, { stepCount });
  const adaptersToTry = fallbackSequence(primaryAdapter, capabilities);

  appendExecutionEvent(params.cwd, {
    ts: Date.now(),
    type: "adapter_selected",
    runId,
    meta: { adapter: primaryAdapter, stepCount },
  });

  try {
    let lastError: unknown;

    for (let i = 0; i < adaptersToTry.length; i += 1) {
      const adapter = adaptersToTry[i];
      try {
        if (i > 0) {
          appendExecutionEvent(params.cwd, {
            ts: Date.now(),
            type: "adapter_fallback",
            runId,
            meta: {
              from: adaptersToTry[i - 1],
              to: adapter,
              reason: lastError instanceof Error ? lastError.message : String(lastError),
            },
          });
        }

        return await runWithAdapter(adapter, params, runId, controller.signal);
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error("No adapter could execute the run.");
  } finally {
    activeRunsByCwd.delete(params.cwd);
  }
}
