import { describe, test, expect, beforeEach } from "vitest";
import { RunProgressState, activeRuns } from "../../src/orchestrator/run-progress.js";

describe("RunProgressState", () => {
  let state: RunProgressState;

  beforeEach(() => {
    state = new RunProgressState();
  });

  describe("addTask", () => {
    test("initializes with pending status and correct name", () => {
      state.addTask(1, "Implement feature");
      const task = state.tasks.get(1);
      expect(task).toBeDefined();
      expect(task!.name).toBe("Implement feature");
      expect(task!.status).toBe("pending");
      expect(task!.taskId).toBe(1);
      expect(task!.toolCount).toBe(0);
      expect(task!.filesChanged).toBe(0);
      expect(task!.currentActivity).toBe("");
      expect(task!.startedAt).toBeTypeOf("number");
    });
  });

  describe("setStatus", () => {
    beforeEach(() => {
      state.addTask(1, "Task one");
    });

    test("updates task status", () => {
      state.setStatus(1, "running");
      expect(state.tasks.get(1)!.status).toBe("running");
    });

    test("records completedAt for 'done' status", () => {
      const before = Date.now();
      state.setStatus(1, "done");
      const task = state.tasks.get(1)!;
      expect(task.completedAt).toBeGreaterThanOrEqual(before);
      expect(task.completedAt).toBeLessThanOrEqual(Date.now());
    });

    test("records completedAt for 'done_with_concerns' status", () => {
      const before = Date.now();
      state.setStatus(1, "done_with_concerns", "Minor issue found");
      const task = state.tasks.get(1)!;
      expect(task.completedAt).toBeGreaterThanOrEqual(before);
    });

    test("records completedAt for 'blocked' status", () => {
      const before = Date.now();
      state.setStatus(1, "blocked", "Missing dependency");
      const task = state.tasks.get(1)!;
      expect(task.completedAt).toBeGreaterThanOrEqual(before);
    });

    test("does not set completedAt for non-terminal statuses", () => {
      state.setStatus(1, "running");
      expect(state.tasks.get(1)!.completedAt).toBeUndefined();
    });

    test("stores error reason for blocked", () => {
      state.setStatus(1, "blocked", "Cannot proceed without API key");
      expect(state.tasks.get(1)!.errorReason).toBe("Cannot proceed without API key");
    });

    test("stores concerns for done_with_concerns", () => {
      state.setStatus(1, "done_with_concerns", "Performance could be improved");
      expect(state.tasks.get(1)!.concerns).toBe("Performance could be improved");
    });

    test("ignores operation on non-existent task (no throw)", () => {
      expect(() => state.setStatus(999, "done")).not.toThrow();
    });
  });

  describe("setActivity", () => {
    test("updates current activity", () => {
      state.addTask(1, "Task one");
      state.setActivity(1, "Running tests");
      expect(state.tasks.get(1)!.currentActivity).toBe("Running tests");
    });

    test("ignores operation on non-existent task (no throw)", () => {
      expect(() => state.setActivity(999, "Some activity")).not.toThrow();
    });
  });

  describe("incrementTools", () => {
    test("increments tool count", () => {
      state.addTask(1, "Task one");
      state.incrementTools(1);
      state.incrementTools(1);
      expect(state.tasks.get(1)!.toolCount).toBe(2);
    });

    test("ignores operation on non-existent task (no throw)", () => {
      expect(() => state.incrementTools(999)).not.toThrow();
    });
  });

  describe("incrementFiles", () => {
    test("increments file count", () => {
      state.addTask(1, "Task one");
      state.incrementFiles(1);
      state.incrementFiles(1);
      state.incrementFiles(1);
      expect(state.tasks.get(1)!.filesChanged).toBe(3);
    });

    test("ignores operation on non-existent task (no throw)", () => {
      expect(() => state.incrementFiles(999)).not.toThrow();
    });
  });

  describe("summary", () => {
    test("counts statuses correctly", () => {
      state.addTask(1, "Pending task");

      state.addTask(2, "Done task");
      state.setStatus(2, "done");

      state.addTask(3, "Done with concerns task");
      state.setStatus(3, "done_with_concerns", "minor issue");

      state.addTask(4, "Running task");
      state.setStatus(4, "running");

      state.addTask(5, "Blocked task");
      state.setStatus(5, "blocked", "error");

      state.addTask(6, "Reviewing task");
      state.setStatus(6, "reviewing");

      const s = state.summary;
      expect(s.total).toBe(6);
      expect(s.pending).toBe(1);
      expect(s.done).toBe(2); // done + done_with_concerns
      expect(s.running).toBe(2); // running + reviewing
      expect(s.blocked).toBe(1);
    });

    test("returns zeros for empty state", () => {
      const s = state.summary;
      expect(s.total).toBe(0);
      expect(s.done).toBe(0);
      expect(s.running).toBe(0);
      expect(s.blocked).toBe(0);
      expect(s.pending).toBe(0);
    });
  });
  describe("onChange callback", () => {
    test("fires on addTask", () => {
      const calls: number[] = [];
      state.onChange = () => calls.push(1);
      state.addTask(1, "task-1");
      expect(calls).toHaveLength(1);
    });

    test("fires on setStatus", () => {
      state.addTask(1, "task-1");
      const calls: number[] = [];
      state.onChange = () => calls.push(1);
      state.setStatus(1, "running");
      expect(calls).toHaveLength(1);
    });

    test("fires on setActivity", () => {
      state.addTask(1, "task-1");
      const calls: number[] = [];
      state.onChange = () => calls.push(1);
      state.setActivity(1, "compiling");
      expect(calls).toHaveLength(1);
    });

    test("fires on incrementTools", () => {
      state.addTask(1, "task-1");
      const calls: number[] = [];
      state.onChange = () => calls.push(1);
      state.incrementTools(1);
      expect(calls).toHaveLength(1);
    });

    test("fires on incrementFiles", () => {
      state.addTask(1, "task-1");
      const calls: number[] = [];
      state.onChange = () => calls.push(1);
      state.incrementFiles(1);
      expect(calls).toHaveLength(1);
    });

    test("fires on batchLabel change", () => {
      const calls: number[] = [];
      state.onChange = () => calls.push(1);
      state.batchLabel = "Batch 1/3";
      expect(calls).toHaveLength(1);
    });

    test("does not fire when onChange is not set", () => {
      // Should not throw
      state.addTask(1, "task-1");
      state.setStatus(1, "running");
      state.setActivity(1, "compiling");
      state.incrementTools(1);
      state.incrementFiles(1);
      state.batchLabel = "Batch 1/3";
    });
  });
});

describe("activeRuns store", () => {
  beforeEach(() => {
    activeRuns.clear();
  });

  test("stores and retrieves a RunProgressState by runId", () => {
    const state = new RunProgressState();
    state.addTask(1, "Task A");
    activeRuns.set("run-42", state);
    const retrieved = activeRuns.get("run-42");
    expect(retrieved).toBe(state);
    expect(retrieved!.tasks.get(1)!.name).toBe("Task A");
  });

  test("delete removes the entry", () => {
    const state = new RunProgressState();
    activeRuns.set("run-99", state);
    expect(activeRuns.has("run-99")).toBe(true);
    activeRuns.delete("run-99");
    expect(activeRuns.has("run-99")).toBe(false);
  });

  describe("abort", () => {
    test("abort() sets aborted flag and fires signal", () => {
      const state = new RunProgressState();
      expect(state.aborted).toBe(false);
      expect(state.signal.aborted).toBe(false);

      let signalFired = false;
      state.signal.addEventListener("abort", () => { signalFired = true; });

      state.abort();

      expect(state.aborted).toBe(true);
      expect(state.signal.aborted).toBe(true);
      expect(signalFired).toBe(true);
    });

    test("calling abort() twice does not throw", () => {
      const state = new RunProgressState();
      state.abort();
      expect(() => state.abort()).not.toThrow();
      expect(state.aborted).toBe(true);
    });

    test("activeRuns lookup enables ESC handler to find running state", () => {
      const state = new RunProgressState();
      activeRuns.set("esc-test", state);

      // Simulate what the ESC handler does
      for (const s of activeRuns.values()) {
        if (!s.aborted) {
          s.abort();
        }
      }

      expect(state.aborted).toBe(true);
      activeRuns.delete("esc-test");
    });
  });
});
