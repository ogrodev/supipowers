import type {
  ResolvedUltraPlanSlotBinding,
  UltraPlanLaunchContext,
} from "../../types.js";
import type { UltraPlanExecutionTarget } from "../execution/policy.js";

export interface ActiveUltraPlanExecution {
  sessionId: string;
  cwd: string;
  target: UltraPlanExecutionTarget;
  launchContext: UltraPlanLaunchContext;
  slotBinding?: ResolvedUltraPlanSlotBinding | null;
}

let activeExecution: ActiveUltraPlanExecution | null = null;

export function bindActiveUltraPlanExecution(execution: ActiveUltraPlanExecution): void {
  activeExecution = execution;
}

export function readActiveUltraPlanExecution(): ActiveUltraPlanExecution | null {
  return activeExecution;
}

export function clearActiveUltraPlanExecution(): void {
  activeExecution = null;
}
