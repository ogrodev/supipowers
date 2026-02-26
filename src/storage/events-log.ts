import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir } from "./state-store";

export type WorkflowEventType =
  | "workflow_started"
  | "design_approved"
  | "plan_ready"
  | "execution_requested"
  | "execution_stopped"
  | "workflow_finished"
  | "workflow_reset"
  | "workflow_rewound"
  | "qa_matrix_prepared"
  | "qa_run_completed"
  | "recovery_applied";

export interface WorkflowEvent {
  ts: number;
  type: WorkflowEventType;
  phase?: string;
  meta?: Record<string, unknown>;
}

function eventLogPath(cwd: string): string {
  return join(cwd, ".pi", "supipowers", "workflow-events.jsonl");
}

export function appendWorkflowEvent(cwd: string, event: WorkflowEvent): void {
  ensureStateDir(cwd);
  appendFileSync(eventLogPath(cwd), `${JSON.stringify(event)}\n`, "utf-8");
}

export function readWorkflowEvents(cwd: string): WorkflowEvent[] {
  const path = eventLogPath(cwd);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WorkflowEvent);
}
