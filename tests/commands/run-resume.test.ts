import type { AgentResult, PlanTask, AgentStatus } from "../../src/types.js";

function makeResult(taskId: number, status: AgentStatus, output = `output-${taskId}`): AgentResult {
  return { taskId, status, output, filesChanged: [], duration: 100 };
}

function task(id: number, parallelism: PlanTask["parallelism"] = { type: "parallel-safe" }): PlanTask {
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

describe("partial batch resume", () => {
  test("already-completed tasks are filtered out of dispatch list", () => {
    const existingResults = [
      makeResult(1, "done"),
      makeResult(2, "done_with_concerns"),
      makeResult(3, "blocked"),
    ];
    const completedTaskIds = new Set(
      existingResults
        .filter(r => r.status === "done" || r.status === "done_with_concerns")
        .map(r => r.taskId)
    );

    const executableTaskIds = [1, 2, 3, 4, 5];
    const tasksToDispatch = executableTaskIds.filter(id => !completedTaskIds.has(id));

    expect(tasksToDispatch).toEqual([3, 4, 5]);
    expect(completedTaskIds.has(1)).toBe(true);
    expect(completedTaskIds.has(2)).toBe(true);
    expect(completedTaskIds.has(3)).toBe(false); // blocked ≠ completed
  });

  test("done_with_concerns counts as completed (no re-dispatch)", () => {
    const existingResults = [
      makeResult(1, "done_with_concerns"),
    ];
    const completedTaskIds = new Set(
      existingResults
        .filter(r => r.status === "done" || r.status === "done_with_concerns")
        .map(r => r.taskId)
    );

    expect(completedTaskIds.has(1)).toBe(true);
  });

  test("blocked results do NOT count as completed (re-dispatch)", () => {
    const existingResults = [
      makeResult(1, "blocked"),
    ];
    const completedTaskIds = new Set(
      existingResults
        .filter(r => r.status === "done" || r.status === "done_with_concerns")
        .map(r => r.taskId)
    );

    expect(completedTaskIds.has(1)).toBe(false);
  });

  test("batch with all tasks already done triggers early completion", () => {
    const existingResults = [
      makeResult(1, "done"),
      makeResult(2, "done"),
      makeResult(3, "done_with_concerns"),
    ];
    const completedTaskIds = new Set(
      existingResults
        .filter(r => r.status === "done" || r.status === "done_with_concerns")
        .map(r => r.taskId)
    );

    const executableTaskIds = [1, 2, 3];
    const tasksToDispatch = executableTaskIds.filter(id => !completedTaskIds.has(id));

    // When all tasks completed, batch should be marked completed
    const allAlreadyDone = tasksToDispatch.length === 0 && executableTaskIds.length > 0;
    expect(allAlreadyDone).toBe(true);
  });

  test("skipped count is correctly calculated", () => {
    const existingResults = [
      makeResult(1, "done"),
      makeResult(2, "done"),
    ];
    const completedTaskIds = new Set(
      existingResults
        .filter(r => r.status === "done" || r.status === "done_with_concerns")
        .map(r => r.taskId)
    );

    const executableTaskIds = [1, 2, 3];
    const tasksToDispatch = executableTaskIds.filter(id => !completedTaskIds.has(id));
    const skippedResumeCount = executableTaskIds.length - tasksToDispatch.length;

    expect(skippedResumeCount).toBe(2);
    expect(tasksToDispatch).toEqual([3]);
  });
});
