import type { ExecutionCapabilities } from "../adapters/capability-detector";
import { executeWithRouter, stopActiveRun } from "../adapters/router";
import { transitionState } from "../engine/state-machine";
import { evaluateVerificationGate } from "../quality/verification-gate";
import type { ExecutionProgressUpdate } from "./progress";
import type { Strictness, WorkflowState } from "../types";

export interface ExecuteWorkflowResult {
  ok: boolean;
  state: WorkflowState;
  message: string;
  runId?: string;
  adapter?: string;
}

export async function executeCurrentPlan(
  cwd: string,
  state: WorkflowState,
  strictness: Strictness,
  capabilities: ExecutionCapabilities,
  onProgress?: (update: ExecutionProgressUpdate) => void,
): Promise<ExecuteWorkflowResult> {
  if (state.phase !== "plan_ready") {
    return {
      ok: false,
      state,
      message: `Cannot execute from phase '${state.phase}'. Move to plan_ready first.`,
    };
  }

  const precheck = evaluateVerificationGate({
    cwd,
    state,
    strictness,
    stage: "pre_execute",
  });

  if (precheck.blocking) {
    return {
      ok: false,
      state: {
        ...state,
        phase: "blocked",
        blocker: precheck.summary,
        nextAction: precheck.nextActions[0] ?? "Resolve quality gate blockers and retry execution.",
        updatedAt: Date.now(),
      },
      message: `${precheck.summary}\n${precheck.nextActions.join("\n")}`.trim(),
    };
  }

  const toExecuting = transitionState(state, {
    to: "executing",
    strictness,
    checkpoints: state.checkpoints,
    nextAction: "Executing plan steps...",
  });

  if (!toExecuting.ok) {
    return {
      ok: false,
      state: toExecuting.state,
      message: `Execution blocked: ${toExecuting.reason}`,
    };
  }

  const executingState = toExecuting.state;
  const result = await executeWithRouter({
    cwd,
    objective: executingState.objective,
    planArtifactPath: executingState.planArtifactPath,
    capabilities,
    onProgress,
  });

  if (result.status === "completed") {
    const toReview = transitionState(executingState, {
      to: "review_pending",
      strictness,
      checkpoints: executingState.checkpoints,
      nextAction: `Review run ${result.runId} summary at ${result.summaryPath}`,
    });

    if (!toReview.ok) {
      return {
        ok: false,
        state: toReview.state,
        message: `Execution completed but transition to review failed: ${toReview.reason}`,
        runId: result.runId,
        adapter: result.adapter,
      };
    }

    return {
      ok: true,
      state: toReview.state,
      message: `Execution completed with run ${result.runId} (${result.adapter}).`,
      runId: result.runId,
      adapter: result.adapter,
    };
  }

  if (result.status === "stopped") {
    const stoppedState = {
      ...executingState,
      phase: "aborted" as const,
      blocker: "Execution was stopped by user",
      nextAction: "Re-run /sp-execute when ready",
      updatedAt: Date.now(),
    };

    return {
      ok: false,
      state: stoppedState,
      message: `Execution stopped (run ${result.runId}).`,
      runId: result.runId,
      adapter: result.adapter,
    };
  }

  const failedState = {
    ...executingState,
    phase: "blocked" as const,
    blocker: `Execution failed for run ${result.runId}`,
    nextAction: "Inspect run summary and resolve issues before retrying",
    updatedAt: Date.now(),
  };

  return {
    ok: false,
    state: failedState,
    message: `Execution failed (run ${result.runId}).`,
    runId: result.runId,
    adapter: result.adapter,
  };
}

export function stopExecution(cwd: string): { stopped: boolean; message: string; runId?: string } {
  const result = stopActiveRun(cwd);
  if (!result.stopped) {
    return { stopped: false, message: "No active execution run to stop." };
  }

  return {
    stopped: true,
    runId: result.runId,
    message: `Stop signal sent to run ${result.runId}.`,
  };
}
