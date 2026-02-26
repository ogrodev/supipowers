import type { StatusSnapshot, Strictness, WorkflowPhase, WorkflowState } from "../types";

function phaseIcon(phase: WorkflowPhase): string {
  switch (phase) {
    case "idle":
      return "⏸️";
    case "brainstorming":
      return "💡";
    case "design_pending_approval":
      return "🧩";
    case "design_approved":
      return "✅";
    case "planning":
      return "🗺️";
    case "plan_ready":
      return "📋";
    case "executing":
      return "⚙️";
    case "review_pending":
      return "👀";
    case "ready_to_finish":
      return "🏁";
    case "completed":
      return "🎉";
    case "blocked":
      return "⛔";
    case "aborted":
      return "🛑";
    default:
      return "🧠";
  }
}

function compactObjective(objective?: string): string {
  if (!objective) return "(no objective)";
  if (objective.length <= 48) return objective;
  return `${objective.slice(0, 45)}...`;
}

export function toStatusSnapshot(state: WorkflowState): StatusSnapshot {
  return {
    phase: state.phase,
    blocker: state.blocker,
    nextAction: state.nextAction,
  };
}

export function formatStatus(snapshot: StatusSnapshot): string {
  const blocker = snapshot.blocker ? ` | blocker: ${snapshot.blocker}` : "";
  return `Supipowers phase: ${snapshot.phase}${blocker} | next: ${snapshot.nextAction}`;
}

export function buildCompactStatusLine(state: WorkflowState): string {
  const blocker = state.blocker ? "🔒" : "🔓";
  return `${phaseIcon(state.phase)}: ${state.phase} | 🎯: ${compactObjective(state.objective)} | ${blocker}`;
}

export function buildStatusLine(state: WorkflowState, strictness: Strictness): string {
  const blocker = state.blocker ? ` | 🔒 blocker: ${state.blocker}` : " | 🔓 blocker: clear";
  return `${phaseIcon(state.phase)} Supipowers phase: ${state.phase}${blocker} | 📌 next: ${state.nextAction} | 🧱 strictness: ${strictness}`;
}
