import { runInBatches } from "../execution/batch-runner";
import { parsePlanSteps } from "../execution/plan-steps";
import type { ExecutionProgressUpdate } from "../execution/progress";
import { appendExecutionEvent, writeRunArtifacts } from "../storage/execution-history";
import { normalizeColonySignal, type ColonyPhase } from "./normalizers/ant-colony-signal";

export interface AntColonyExecutionParams {
  cwd: string;
  runId: string;
  objective?: string;
  planArtifactPath?: string;
  signal?: AbortSignal;
  onProgress?: (update: ExecutionProgressUpdate) => void;
}

export interface AntColonyExecutionResult {
  runId: string;
  adapter: "ant_colony";
  status: "completed" | "failed" | "stopped";
  completedSteps: number;
  totalSteps: number;
  summaryPath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(
  params: AntColonyExecutionParams,
  phase: ColonyPhase,
  progress: number,
  message: string,
): void {
  const signal = normalizeColonySignal(phase, progress, message);
  params.onProgress?.({
    adapter: "ant_colony",
    phase: signal.phase,
    progress: signal.progress,
    message: signal.message,
  });
}

export async function executeAntColonyAdapter(params: AntColonyExecutionParams): Promise<AntColonyExecutionResult> {
  const steps = parsePlanSteps(params.planArtifactPath);
  const outputs: string[] = [];

  appendExecutionEvent(params.cwd, {
    ts: Date.now(),
    type: "execution_started",
    runId: params.runId,
    meta: {
      adapter: "ant_colony",
      objective: params.objective,
      totalSteps: steps.length,
    },
  });

  try {
    emit(params, "scouting", 0.1, "Scouts are analyzing project context");
    await sleep(8);
    emit(params, "planning", 0.25, "Queen is planning worker tasks");
    await sleep(8);

    await runInBatches({
      items: steps,
      batchSize: 4,
      signal: params.signal,
      runItem: async (step, index) => {
        await sleep(7);
        const out = `🐜 worker-${(index % 4) + 1} completed: ${step}`;
        outputs.push(out);

        const progress = 0.25 + ((index + 1) / Math.max(1, steps.length)) * 0.6;
        emit(params, "workers", progress, `Workers completed ${index + 1}/${steps.length} tasks`);
        return out;
      },
      onBatchComplete: ({ completed, total }) => {
        appendExecutionEvent(params.cwd, {
          ts: Date.now(),
          type: "execution_checkpoint",
          runId: params.runId,
          meta: {
            adapter: "ant_colony",
            phase: "workers",
            completed,
            total,
          },
        });
      },
    });

    emit(params, "review", 0.92, "Soldiers are reviewing colony output");
    await sleep(8);
    emit(params, "complete", 1, "Colony execution complete");

    const summary = [
      `# Supipowers Run ${params.runId}`,
      "",
      `Adapter: ant_colony`,
      `Status: completed`,
      `Objective: ${params.objective ?? "(not specified)"}`,
      "",
      "## Colony Output",
      ...outputs.map((line, index) => `${index + 1}. ${line}`),
    ].join("\n");

    const artifacts = writeRunArtifacts(params.cwd, params.runId, summary, {
      adapter: "ant_colony",
      status: "completed",
      completedSteps: steps.length,
      totalSteps: steps.length,
      outputs,
    });

    appendExecutionEvent(params.cwd, {
      ts: Date.now(),
      type: "execution_completed",
      runId: params.runId,
      meta: {
        adapter: "ant_colony",
        completedSteps: steps.length,
        totalSteps: steps.length,
        summaryPath: artifacts.summaryPath,
      },
    });

    return {
      runId: params.runId,
      adapter: "ant_colony",
      status: "completed",
      completedSteps: steps.length,
      totalSteps: steps.length,
      summaryPath: artifacts.summaryPath,
    };
  } catch (error) {
    const stopped = params.signal?.aborted || (error instanceof Error && error.message.includes("aborted"));
    const status: "stopped" | "failed" = stopped ? "stopped" : "failed";

    const summary = [
      `# Supipowers Run ${params.runId}`,
      "",
      `Adapter: ant_colony`,
      `Status: ${status}`,
      `Objective: ${params.objective ?? "(not specified)"}`,
      "",
      "## Completed Colony Output",
      ...outputs.map((line, index) => `${index + 1}. ${line}`),
    ].join("\n");

    const artifacts = writeRunArtifacts(params.cwd, params.runId, summary, {
      adapter: "ant_colony",
      status,
      completedSteps: outputs.length,
      totalSteps: steps.length,
      outputs,
      error: error instanceof Error ? error.message : String(error),
    });

    appendExecutionEvent(params.cwd, {
      ts: Date.now(),
      type: status === "stopped" ? "execution_stopped" : "execution_failed",
      runId: params.runId,
      meta: {
        adapter: "ant_colony",
        completedSteps: outputs.length,
        totalSteps: steps.length,
        summaryPath: artifacts.summaryPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    return {
      runId: params.runId,
      adapter: "ant_colony",
      status,
      completedSteps: outputs.length,
      totalSteps: steps.length,
      summaryPath: artifacts.summaryPath,
    };
  }
}
