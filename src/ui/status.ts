import type { StatusSnapshot, Strictness, WorkflowState } from "../types";

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

export function buildStatusLine(state: WorkflowState, strictness: Strictness): string {
  return `${formatStatus(toStatusSnapshot(state))} | strictness: ${strictness}`;
}
