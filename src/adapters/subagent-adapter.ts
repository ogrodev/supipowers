import { runInBatches } from "../execution/batch-runner";
import { parsePlanSteps } from "../execution/plan-steps";
import type { ExecutionProgressUpdate } from "../execution/progress";
import { normalizeSubagentResult, type RawSubagentRun } from "./normalizers/subagent-result";
import { appendExecutionEvent, writeRunArtifacts } from "../storage/execution-history";

export type SubagentMode = "single" | "chain" | "parallel";

export interface SubagentExecutionParams {
  cwd: string;
  runId: string;
  objective?: string;
  planArtifactPath?: string;
  mode?: SubagentMode | "auto";
  signal?: AbortSignal;
  onProgress?: (update: ExecutionProgressUpdate) => void;
}

export interface SubagentExecutionResult {
  runId: string;
  adapter: "subagent";
  mode: SubagentMode;
  status: "completed" | "failed" | "stopped";
  completedSteps: number;
  totalSteps: number;
  summaryPath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveMode(mode: SubagentExecutionParams["mode"], stepCount: number): SubagentMode {
  if (mode && mode !== "auto") return mode;
  if (stepCount <= 1) return "single";
  if (stepCount <= 3) return "chain";
  return "parallel";
}

function assignAgent(index: number): string {
  const sequence = ["scout", "planner", "worker", "reviewer"];
  return sequence[index % sequence.length];
}

export async function executeSubagentAdapter(params: SubagentExecutionParams): Promise<SubagentExecutionResult> {
  const planSteps = parsePlanSteps(params.planArtifactPath);
  const mode = resolveMode(params.mode, planSteps.length);
  const selectedSteps = mode === "single" ? planSteps.slice(0, 1) : planSteps;

  appendExecutionEvent(params.cwd, {
    ts: Date.now(),
    type: "execution_started",
    runId: params.runId,
    meta: {
      adapter: "subagent",
      mode,
      objective: params.objective,
      totalSteps: selectedSteps.length,
    },
  });

  params.onProgress?.({
    adapter: "subagent",
    phase: `${mode}:start`,
    progress: 0,
    message: `Subagent ${mode} execution started`,
  });

  const raw: RawSubagentRun = {
    id: params.runId,
    mode,
    status: "completed",
    steps: [],
  };

  try {
    if (mode === "parallel") {
      await runInBatches({
        items: selectedSteps,
        batchSize: 3,
        signal: params.signal,
        runItem: async (step, index) => {
          await sleep(6);
          const output = `👥 ${assignAgent(index)} completed: ${step}`;
          raw.steps.push({ agent: assignAgent(index), task: step, output });
          return output;
        },
        onBatchComplete: ({ completed, total }) => {
          const latest = raw.steps[raw.steps.length - 1]?.task;
          appendExecutionEvent(params.cwd, {
            ts: Date.now(),
            type: "execution_checkpoint",
            runId: params.runId,
            meta: { completed, total, latestStep: latest, mode },
          });
          params.onProgress?.({
            adapter: "subagent",
            phase: `${mode}:running`,
            progress: total === 0 ? 0 : completed / total,
            message: `Subagent ${mode} ${completed}/${total}: ${latest}`,
          });
        },
      });
    } else {
      await runInBatches({
        items: selectedSteps,
        batchSize: 1,
        signal: params.signal,
        runItem: async (step, index) => {
          await sleep(8);
          const output = `👥 ${assignAgent(index)} completed: ${step}`;
          raw.steps.push({ agent: assignAgent(index), task: step, output });
          return output;
        },
        onBatchComplete: ({ completed, total }) => {
          const latest = raw.steps[raw.steps.length - 1]?.task;
          appendExecutionEvent(params.cwd, {
            ts: Date.now(),
            type: "execution_checkpoint",
            runId: params.runId,
            meta: { completed, total, latestStep: latest, mode },
          });
          params.onProgress?.({
            adapter: "subagent",
            phase: `${mode}:running`,
            progress: total === 0 ? 0 : completed / total,
            message: `Subagent ${mode} ${completed}/${total}: ${latest}`,
          });
        },
      });
    }

    const normalized = normalizeSubagentResult(raw);

    const summary = [
      `# Supipowers Run ${params.runId}`,
      "",
      `Adapter: subagent`,
      `Mode: ${mode}`,
      `Status: completed`,
      `Objective: ${params.objective ?? "(not specified)"}`,
      "",
      "## Steps",
      ...normalized.outputs.map((line, index) => `${index + 1}. ${line}`),
    ].join("\n");

    const artifacts = writeRunArtifacts(params.cwd, params.runId, summary, {
      adapter: "subagent",
      mode,
      status: "completed",
      completedSteps: normalized.completedSteps,
      totalSteps: normalized.totalSteps,
      objective: params.objective,
      steps: raw.steps,
    });

    appendExecutionEvent(params.cwd, {
      ts: Date.now(),
      type: "execution_completed",
      runId: params.runId,
      meta: {
        adapter: "subagent",
        mode,
        completedSteps: normalized.completedSteps,
        totalSteps: normalized.totalSteps,
        summaryPath: artifacts.summaryPath,
      },
    });

    params.onProgress?.({
      adapter: "subagent",
      phase: `${mode}:complete`,
      progress: 1,
      message: `Subagent ${mode} execution complete`,
    });

    return {
      runId: params.runId,
      adapter: "subagent",
      mode,
      status: "completed",
      completedSteps: normalized.completedSteps,
      totalSteps: normalized.totalSteps,
      summaryPath: artifacts.summaryPath,
    };
  } catch (error) {
    const stopped = params.signal?.aborted || error instanceof Error && error.message.includes("aborted");
    raw.status = stopped ? "stopped" : "failed";

    const normalized = normalizeSubagentResult(raw);

    const summary = [
      `# Supipowers Run ${params.runId}`,
      "",
      `Adapter: subagent`,
      `Mode: ${mode}`,
      `Status: ${raw.status}`,
      `Objective: ${params.objective ?? "(not specified)"}`,
      "",
      "## Completed Steps",
      ...normalized.outputs.map((line, index) => `${index + 1}. ${line}`),
    ].join("\n");

    const artifacts = writeRunArtifacts(params.cwd, params.runId, summary, {
      adapter: "subagent",
      mode,
      status: raw.status,
      completedSteps: normalized.completedSteps,
      totalSteps: normalized.totalSteps,
      objective: params.objective,
      steps: raw.steps,
      error: error instanceof Error ? error.message : String(error),
    });

    appendExecutionEvent(params.cwd, {
      ts: Date.now(),
      type: raw.status === "stopped" ? "execution_stopped" : "execution_failed",
      runId: params.runId,
      meta: {
        adapter: "subagent",
        mode,
        completedSteps: normalized.completedSteps,
        totalSteps: normalized.totalSteps,
        summaryPath: artifacts.summaryPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    params.onProgress?.({
      adapter: "subagent",
      phase: `${mode}:${raw.status}`,
      progress: Math.min(1, normalized.completedSteps / Math.max(1, normalized.totalSteps)),
      message: `Subagent ${mode} execution ${raw.status}`,
    });

    return {
      runId: params.runId,
      adapter: "subagent",
      mode,
      status: raw.status,
      completedSteps: normalized.completedSteps,
      totalSteps: normalized.totalSteps,
      summaryPath: artifacts.summaryPath,
    };
  }
}
