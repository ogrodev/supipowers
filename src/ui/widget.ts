import type { Strictness, WorkflowState } from "../types";

export function buildWidgetLines(state: WorkflowState, strictness: Strictness): string[] {
  const blockerState = state.blocker ? "🔒" : "🔓";

  const lines = [
    `🧠 Supipowers`,
    `🧭 Phase: ${state.phase}`,
    `🎯 Objective: ${state.objective ?? "(not set)"}`,
    `🧱 Strictness: ${strictness}`,
    `📌 Next: ${state.nextAction}`,
    `🚪 Blocker: ${blockerState}${state.blocker ? ` — ${state.blocker}` : ""}`,
  ];

  if (state.planArtifactPath) lines.push(`🗺️ Plan: ${state.planArtifactPath}`);

  return lines;
}
