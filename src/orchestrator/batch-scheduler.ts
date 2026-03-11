// src/orchestrator/batch-scheduler.ts
import type { PlanTask, RunBatch } from "../types.js";

/**
 * Group plan tasks into execution batches.
 * Parallel-safe tasks with no pending dependencies run together.
 * Sequential tasks wait for their dependencies.
 */
export function scheduleBatches(
  tasks: PlanTask[],
  maxParallel: number
): RunBatch[] {
  const batches: RunBatch[] = [];
  const completed = new Set<number>();
  const remaining = new Set(tasks.map((t) => t.id));

  let batchIndex = 0;

  while (remaining.size > 0) {
    const ready: number[] = [];

    for (const task of tasks) {
      if (!remaining.has(task.id)) continue;

      if (task.parallelism.type === "parallel-safe") {
        ready.push(task.id);
      } else if (task.parallelism.type === "sequential") {
        const depsReady = task.parallelism.dependsOn.every((dep) =>
          completed.has(dep)
        );
        if (depsReady) ready.push(task.id);
      }

      if (ready.length >= maxParallel) break;
    }

    if (ready.length === 0) {
      // Deadlock: remaining tasks have unresolvable dependencies
      // Force the first remaining task into a batch
      const first = [...remaining][0];
      ready.push(first);
    }

    const batch: RunBatch = {
      index: batchIndex++,
      taskIds: ready.slice(0, maxParallel),
      status: "pending",
    };

    for (const id of batch.taskIds) {
      remaining.delete(id);
      completed.add(id);
    }

    batches.push(batch);
  }

  return batches;
}
