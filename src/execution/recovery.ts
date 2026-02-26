import { getActiveRun } from "../adapters/router";
import type { WorkflowState } from "../types";

export interface RecoveryResult {
  recovered: boolean;
  state: WorkflowState;
  reason?: string;
}

export function recoverInterruptedExecutionState(cwd: string, state: WorkflowState): RecoveryResult {
  if (state.phase !== "executing") {
    return { recovered: false, state };
  }

  const active = getActiveRun(cwd);
  if (active) {
    return { recovered: false, state };
  }

  const recoveredState: WorkflowState = {
    ...state,
    phase: "blocked",
    blocker: "Execution appears to have been interrupted.",
    nextAction: "Re-run /sp-execute to resume workflow or /sp-reset to restart.",
    updatedAt: Date.now(),
  };

  return {
    recovered: true,
    state: recoveredState,
    reason: "Detected stale executing phase without active run.",
  };
}
