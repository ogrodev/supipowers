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

const activeExecutions = new Map<string, ActiveUltraPlanExecution>();

function buildActiveExecutionKey(sessionId: string, cwd: string, attemptId: string): string {
  return `${sessionId}\u0000${cwd}\u0000${attemptId}`;
}

function buildExecutionKey(execution: ActiveUltraPlanExecution): string {
  return buildActiveExecutionKey(execution.sessionId, execution.cwd, execution.launchContext.attemptId);
}

export function bindActiveUltraPlanExecution(execution: ActiveUltraPlanExecution): void {
  activeExecutions.set(buildExecutionKey(execution), execution);
}

export function listActiveUltraPlanExecutions(): ActiveUltraPlanExecution[] {
  return [...activeExecutions.values()];
}

export function readActiveUltraPlanExecution(): ActiveUltraPlanExecution | null {
  if (activeExecutions.size !== 1) {
    return null;
  }
  return activeExecutions.values().next().value ?? null;
}

export function readActiveUltraPlanExecutionForSession(sessionId: string, cwd: string): ActiveUltraPlanExecution | null {
  const matches = listActiveUltraPlanExecutions().filter((execution) => execution.sessionId === sessionId && execution.cwd === cwd);
  return matches.length === 1 ? matches[0]! : null;
}

export function readActiveUltraPlanExecutionForAttempt(
  sessionId: string,
  cwd: string,
  attemptId: string,
): ActiveUltraPlanExecution | null {
  return activeExecutions.get(buildActiveExecutionKey(sessionId, cwd, attemptId)) ?? null;
}

export function readActiveUltraPlanExecutionForCwd(cwd: string | null): ActiveUltraPlanExecution | null {
  if (!cwd) {
    return null;
  }
  const matches = listActiveUltraPlanExecutions().filter((execution) => execution.cwd === cwd);
  return matches.length === 1 ? matches[0]! : null;
}

export function clearMatchedActiveUltraPlanExecution(sessionId: string, cwd: string, attemptId: string): void {
  activeExecutions.delete(buildActiveExecutionKey(sessionId, cwd, attemptId));
}

export function clearActiveUltraPlanExecution(execution?: ActiveUltraPlanExecution): void {
  if (!execution) {
    activeExecutions.clear();
    return;
  }

  clearMatchedActiveUltraPlanExecution(execution.sessionId, execution.cwd, execution.launchContext.attemptId);
}