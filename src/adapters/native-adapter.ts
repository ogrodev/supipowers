import { runCheckpointedSteps } from "../execution/checkpoint-runner";
import { parsePlanSteps } from "../execution/plan-steps";
import type { ExecutionProgressUpdate } from "../execution/progress";
import { appendExecutionEvent, writeRunArtifacts } from "../storage/execution-history";

export interface NativeExecutionParams {
  cwd: string;
  runId: string;
  objective?: string;
  planArtifactPath?: string;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (update: ExecutionProgressUpdate) => void;
}

export interface NativeExecutionResult {
  runId: string;
  adapter: "native";
  status: "completed" | "failed" | "stopped";
  completedSteps: number;
  totalSteps: number;
  summaryPath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeNativeAdapter(params: NativeExecutionParams): Promise<NativeExecutionResult> {
  const steps = parsePlanSteps(params.planArtifactPath);
  const batchSize = Math.max(1, params.batchSize ?? 2);
  const stepOutputs: string[] = [];

  appendExecutionEvent(params.cwd, {
    ts: Date.now(),
    type: "execution_started",
    runId: params.runId,
    meta: {
      adapter: "native",
      objective: params.objective,
      totalSteps: steps.length,
      batchSize,
    },
  });

  params.onProgress?.({
    adapter: "native",
    phase: "start",
    progress: 0,
    message: "Native execution started",
  });

  try {
    await runCheckpointedSteps({
      steps,
      batchSize,
      signal: params.signal,
      runStep: async (step) => {
        await sleep(8);
        const out = `✅ ${step}`;
        stepOutputs.push(out);
        return out;
      },
      onCheckpoint: ({ completed, total, latestStep }) => {
        appendExecutionEvent(params.cwd, {
          ts: Date.now(),
          type: "execution_checkpoint",
          runId: params.runId,
          meta: { completed, total, latestStep },
        });
        params.onProgress?.({
          adapter: "native",
          phase: "running",
          progress: total === 0 ? 0 : completed / total,
          message: `Native execution ${completed}/${total}: ${latestStep}`,
        });
      },
    });

    const summary = [
      `# Supipowers Run ${params.runId}`,
      "",
      `Adapter: native`,
      `Status: completed`,
      `Objective: ${params.objective ?? "(not specified)"}`,
      "",
      "## Steps",
      ...stepOutputs.map((line, index) => `${index + 1}. ${line}`),
    ].join("\n");

    const artifacts = writeRunArtifacts(params.cwd, params.runId, summary, {
      adapter: "native",
      status: "completed",
      completedSteps: steps.length,
      totalSteps: steps.length,
      objective: params.objective,
      steps,
      stepOutputs,
    });

    appendExecutionEvent(params.cwd, {
      ts: Date.now(),
      type: "execution_completed",
      runId: params.runId,
      meta: {
        completedSteps: steps.length,
        totalSteps: steps.length,
        summaryPath: artifacts.summaryPath,
      },
    });

    params.onProgress?.({
      adapter: "native",
      phase: "complete",
      progress: 1,
      message: "Native execution complete",
    });

    return {
      runId: params.runId,
      adapter: "native",
      status: "completed",
      completedSteps: steps.length,
      totalSteps: steps.length,
      summaryPath: artifacts.summaryPath,
    };
  } catch (error) {
    const stopped = params.signal?.aborted || error instanceof Error && error.message.includes("aborted");
    const status: "stopped" | "failed" = stopped ? "stopped" : "failed";

    const summary = [
      `# Supipowers Run ${params.runId}`,
      "",
      `Adapter: native`,
      `Status: ${status}`,
      `Objective: ${params.objective ?? "(not specified)"}`,
      "",
      "## Completed Steps",
      ...stepOutputs.map((line, index) => `${index + 1}. ${line}`),
    ].join("\n");

    const artifacts = writeRunArtifacts(params.cwd, params.runId, summary, {
      adapter: "native",
      status,
      completedSteps: stepOutputs.length,
      totalSteps: steps.length,
      objective: params.objective,
      steps,
      stepOutputs,
      error: error instanceof Error ? error.message : String(error),
    });

    appendExecutionEvent(params.cwd, {
      ts: Date.now(),
      type: status === "stopped" ? "execution_stopped" : "execution_failed",
      runId: params.runId,
      meta: {
        completedSteps: stepOutputs.length,
        totalSteps: steps.length,
        summaryPath: artifacts.summaryPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    params.onProgress?.({
      adapter: "native",
      phase: status,
      progress: Math.min(1, stepOutputs.length / Math.max(1, steps.length)),
      message: `Native execution ${status}`,
    });

    return {
      runId: params.runId,
      adapter: "native",
      status,
      completedSteps: stepOutputs.length,
      totalSteps: steps.length,
      summaryPath: artifacts.summaryPath,
    };
  }
}
