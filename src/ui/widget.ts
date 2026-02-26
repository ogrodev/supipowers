import type { Strictness, WorkflowState } from "../types";

export function buildWidgetLines(state: WorkflowState, strictness: Strictness): string[] {
  const lines = [
    `🧠 Supipowers`,
    `Phase: ${state.phase}`,
    `Strictness: ${strictness}`,
    `Next: ${state.nextAction}`,
  ];

  if (state.objective) lines.push(`Objective: ${state.objective}`);
  if (state.planArtifactPath) lines.push(`Plan: ${state.planArtifactPath}`);
  if (state.blocker) lines.push(`Blocker: ${state.blocker}`);

  return lines;
}
