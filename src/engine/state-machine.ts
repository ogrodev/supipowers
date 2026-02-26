import { evaluatePhaseGate, type CheckpointContext } from "./checkpoints";
import { canTransition } from "./transitions";
import type { Strictness, TransitionResult, WorkflowPhase, WorkflowState } from "../types";

export interface TransitionInput {
  to: WorkflowPhase;
  strictness: Strictness;
  checkpoints?: CheckpointContext;
  nextAction?: string;
}

export function transitionState(current: WorkflowState, input: TransitionInput): TransitionResult {
  const transition = canTransition(current.phase, input.to);
  if (!transition.ok) {
    return {
      ok: false,
      reason: transition.reason,
      state: { ...current, blocker: transition.reason, updatedAt: Date.now() },
    };
  }

  const gate = evaluatePhaseGate(input.to, input.checkpoints ?? {}, input.strictness);
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason,
      state: { ...current, phase: "blocked", blocker: gate.reason, updatedAt: Date.now() },
    };
  }

  return {
    ok: true,
    state: {
      ...current,
      phase: input.to,
      blocker: undefined,
      nextAction: input.nextAction ?? current.nextAction,
      updatedAt: Date.now(),
    },
  };
}
