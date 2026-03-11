import type { AgentResult, RunBatch } from "../types.js";

export interface BatchSummary {
  batchIndex: number;
  total: number;
  done: number;
  doneWithConcerns: number;
  blocked: number;
  allPassed: boolean;
  concerns: string[];
  blockers: string[];
  filesChanged: string[];
}

export function summarizeBatch(
  batch: RunBatch,
  results: AgentResult[]
): BatchSummary {
  const batchResults = results.filter((r) => batch.taskIds.includes(r.taskId));

  const done = batchResults.filter((r) => r.status === "done").length;
  const doneWithConcerns = batchResults.filter(
    (r) => r.status === "done_with_concerns"
  ).length;
  const blocked = batchResults.filter((r) => r.status === "blocked").length;

  return {
    batchIndex: batch.index,
    total: batch.taskIds.length,
    done,
    doneWithConcerns,
    blocked,
    allPassed: blocked === 0,
    concerns: batchResults
      .filter((r) => r.concerns)
      .map((r) => r.concerns!),
    blockers: batchResults
      .filter((r) => r.status === "blocked")
      .map((r) => r.output),
    filesChanged: batchResults.flatMap((r) => r.filesChanged),
  };
}

export function detectConflicts(results: AgentResult[]): string[] {
  const fileCounts = new Map<string, number>();
  for (const result of results) {
    for (const file of result.filesChanged) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  return [...fileCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file);
}

export function buildRunSummary(allResults: AgentResult[]): {
  totalTasks: number;
  done: number;
  doneWithConcerns: number;
  blocked: number;
  totalFilesChanged: number;
  totalDuration: number;
} {
  return {
    totalTasks: allResults.length,
    done: allResults.filter((r) => r.status === "done").length,
    doneWithConcerns: allResults.filter((r) => r.status === "done_with_concerns").length,
    blocked: allResults.filter((r) => r.status === "blocked").length,
    totalFilesChanged: new Set(allResults.flatMap((r) => r.filesChanged)).size,
    totalDuration: allResults.reduce((sum, r) => sum + r.duration, 0),
  };
}
