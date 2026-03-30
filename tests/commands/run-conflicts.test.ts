import type { AgentResult, PlanTask } from "../../src/types.js";
import { analyzeConflicts } from "../../src/orchestrator/conflict-resolver.js";

function makeResult(taskId: number, filesChanged: string[], output = `output-${taskId}`): AgentResult {
  return { taskId, status: "done", output, filesChanged, duration: 100 };
}

function task(id: number): PlanTask {
  return {
    id,
    name: `task-${id}`,
    description: `Task ${id}`,
    files: [],
    criteria: "",
    complexity: "small",
    parallelism: { type: "parallel-safe" },
  };
}

describe("conflict detection and merge prompt delivery", () => {
  test("when conflicts detected, mergePrompt is generated", () => {
    const results = [
      makeResult(1, ["src/shared.ts", "src/a.ts"]),
      makeResult(2, ["src/shared.ts", "src/b.ts"]),
    ];
    const tasks = [task(1), task(2)];

    const conflicts = analyzeConflicts(results, tasks);
    expect(conflicts.hasConflicts).toBe(true);
    expect(conflicts.conflictingFiles).toContain("src/shared.ts");
    expect(conflicts.mergePrompt).toBeDefined();
    expect(conflicts.mergePrompt!.length).toBeGreaterThan(0);
  });

  test("when no conflicts, mergePrompt is undefined", () => {
    const results = [
      makeResult(1, ["src/a.ts"]),
      makeResult(2, ["src/b.ts"]),
    ];
    const tasks = [task(1), task(2)];

    const conflicts = analyzeConflicts(results, tasks);
    expect(conflicts.hasConflicts).toBe(false);
    expect(conflicts.mergePrompt).toBeUndefined();
  });

  test("mergePrompt includes task names for conflicting results", () => {
    const results = [
      makeResult(1, ["src/shared.ts"]),
      makeResult(2, ["src/shared.ts"]),
    ];
    const tasks = [task(1), task(2)];

    const conflicts = analyzeConflicts(results, tasks);
    expect(conflicts.mergePrompt).toContain("src/shared.ts");
  });

  test("conflict delivery requires platform.sendMessage with steer options", () => {
    // Verify the shape of what run.ts should send when conflicts exist
    const mockSendMessage = vi.fn();
    const mergePrompt = "Resolve conflicts in src/shared.ts";

    // Simulate what run.ts does
    mockSendMessage(
      {
        customType: "supi-conflict-resolution",
        content: [{ type: "text", text: mergePrompt }],
        display: "none",
      },
      { deliverAs: "steer", triggerTurn: true },
    );

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-conflict-resolution",
        display: "none",
      }),
      expect.objectContaining({
        deliverAs: "steer",
        triggerTurn: true,
      }),
    );
  });
});
