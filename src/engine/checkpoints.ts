import { shouldBlockOnMissingGate, type GateImportance } from "./policies";
import type { Strictness, WorkflowPhase } from "../types";

export interface CheckpointContext {
  hasDesignApproval?: boolean;
  hasPlanArtifact?: boolean;
  hasReviewPass?: boolean;
}

interface PhaseGate {
  message: string;
  importance: GateImportance;
  check: (context: CheckpointContext) => boolean;
}

const PHASE_GATES: Partial<Record<WorkflowPhase, PhaseGate>> = {
  design_approved: {
    message: "Design approval is required.",
    importance: "major",
    check: (context) => context.hasDesignApproval === true,
  },
  plan_ready: {
    message: "Plan artifact is required before plan_ready.",
    importance: "major",
    check: (context) => context.hasPlanArtifact === true,
  },
  ready_to_finish: {
    message: "Review pass is required before finishing.",
    importance: "major",
    check: (context) => context.hasReviewPass === true,
  },
};

export function evaluatePhaseGate(
  target: WorkflowPhase,
  context: CheckpointContext,
  strictness: Strictness,
): { ok: boolean; reason?: string } {
  const gate = PHASE_GATES[target];
  if (!gate) return { ok: true };
  if (gate.check(context)) return { ok: true };

  if (shouldBlockOnMissingGate(strictness, gate.importance)) {
    return { ok: false, reason: gate.message };
  }

  return { ok: true };
}
