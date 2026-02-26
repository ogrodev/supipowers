import type { WorkflowPhase } from "../types";

const ALLOWED_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  idle: ["brainstorming", "aborted"],
  brainstorming: ["design_pending_approval", "blocked", "aborted"],
  design_pending_approval: ["design_approved", "blocked", "aborted"],
  design_approved: ["planning", "blocked", "aborted"],
  planning: ["plan_ready", "blocked", "aborted"],
  plan_ready: ["executing", "blocked", "aborted"],
  executing: ["review_pending", "blocked", "aborted"],
  review_pending: ["ready_to_finish", "blocked", "aborted"],
  ready_to_finish: ["completed", "blocked", "aborted"],
  completed: ["idle"],
  blocked: ["planning", "executing", "aborted"],
  aborted: ["idle"],
};

export function canTransition(from: WorkflowPhase, to: WorkflowPhase): { ok: boolean; reason?: string } {
  if (from === to) {
    return { ok: false, reason: `State is already '${to}'.` };
  }

  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `Invalid transition '${from}' -> '${to}'.` };
  }

  return { ok: true };
}
