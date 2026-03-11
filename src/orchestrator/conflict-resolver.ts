import type { AgentResult, PlanTask } from "../types.js";
import { detectConflicts } from "./result-collector.js";
import { buildMergePrompt } from "./prompts.js";

export interface ConflictResolution {
  hasConflicts: boolean;
  conflictingFiles: string[];
  mergePrompt?: string;
}

export function analyzeConflicts(
  results: AgentResult[],
  tasks: PlanTask[]
): ConflictResolution {
  const conflictingFiles = detectConflicts(results);

  if (conflictingFiles.length === 0) {
    return { hasConflicts: false, conflictingFiles: [] };
  }

  const conflictingResults = results.filter((r) =>
    r.filesChanged.some((f) => conflictingFiles.includes(f))
  );

  const agentOutputs = conflictingResults.map((r) => {
    const task = tasks.find((t) => t.id === r.taskId);
    return {
      taskName: task?.name ?? `Task ${r.taskId}`,
      output: r.output,
    };
  });

  return {
    hasConflicts: true,
    conflictingFiles,
    mergePrompt: buildMergePrompt(conflictingFiles, agentOutputs),
  };
}
