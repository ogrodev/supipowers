// tests/orchestrator/batch-scheduler.test.ts
import { describe, test, expect } from "vitest";
import { scheduleBatches } from "../../src/orchestrator/batch-scheduler.js";
import type { PlanTask } from "../../src/types.js";

function task(id: number, parallelism: PlanTask["parallelism"]): PlanTask {
  return {
    id,
    name: `task-${id}`,
    description: `Task ${id}`,
    files: [],
    criteria: "",
    complexity: "small",
    parallelism,
  };
}

describe("scheduleBatches", () => {
  test("groups parallel-safe tasks together", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "parallel-safe" }),
      task(3, { type: "parallel-safe" }),
    ];
    const batches = scheduleBatches(tasks, 3);
    expect(batches).toHaveLength(1);
    expect(batches[0].taskIds).toEqual([1, 2, 3]);
  });

  test("respects maxParallel limit", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "parallel-safe" }),
      task(3, { type: "parallel-safe" }),
    ];
    const batches = scheduleBatches(tasks, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0].taskIds).toHaveLength(2);
    expect(batches[1].taskIds).toHaveLength(1);
  });

  test("sequential tasks wait for dependencies", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "sequential", dependsOn: [1] }),
      task(3, { type: "parallel-safe" }),
    ];
    const batches = scheduleBatches(tasks, 3);
    expect(batches).toHaveLength(2);
    expect(batches[0].taskIds).toContain(1);
    expect(batches[0].taskIds).toContain(3);
    expect(batches[0].taskIds).not.toContain(2);
    expect(batches[1].taskIds).toContain(2);
  });

  test("handles chain dependencies", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "sequential", dependsOn: [1] }),
      task(3, { type: "sequential", dependsOn: [2] }),
    ];
    const batches = scheduleBatches(tasks, 3);
    expect(batches).toHaveLength(3);
    expect(batches[0].taskIds).toEqual([1]);
    expect(batches[1].taskIds).toEqual([2]);
    expect(batches[2].taskIds).toEqual([3]);
  });

  test("handles deadlock by forcing first remaining", () => {
    const tasks = [
      task(1, { type: "sequential", dependsOn: [2] }),
      task(2, { type: "sequential", dependsOn: [1] }),
    ];
    const batches = scheduleBatches(tasks, 2);
    // Should not hang — forces progress
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});
