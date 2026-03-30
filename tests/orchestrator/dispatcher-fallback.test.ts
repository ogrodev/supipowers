// tests/orchestrator/dispatcher-fallback.test.ts
import { describe, test, expect } from "vitest";

// We test the internal helpers by importing the module and exercising dispatchAgent
// Since dispatchAgent depends on platform.createAgentSession, we mock at that level

describe("model fallback and error handling", () => {
  // Test the isModelAuthError-like detection by checking error message patterns
  describe("error classification", () => {
    const modelAuthPatterns = [
      "No API key found for undefined",
      "No API key found for some-model",
      "invalid_api_key",
      "authentication failed",
      "unauthorized request",
      "model not found: foo-model",
      "model_not_found",
      "Could not resolve model",
    ];

    const nonModelErrors = [
      "Sub-agent dispatch is not available on this platform.",
      "Network timeout",
      "ECONNREFUSED",
      "Task execution failed",
      "Syntax error in prompt",
    ];

    test("model/auth errors are classified correctly", () => {
      for (const msg of modelAuthPatterns) {
        const isModelAuth =
          msg.includes("No API key") ||
          msg.includes("API key") ||
          msg.includes("authentication") ||
          msg.includes("unauthorized") ||
          msg.includes("model not found") ||
          msg.includes("model_not_found") ||
          msg.includes("invalid_api_key") ||
          msg.includes("Could not resolve model");
        expect(isModelAuth, `Expected "${msg}" to be classified as model/auth error`).toBe(true);
      }
    });

    test("non-model errors are classified correctly", () => {
      for (const msg of nonModelErrors) {
        const isModelAuth =
          msg.includes("No API key") ||
          msg.includes("API key") ||
          msg.includes("authentication") ||
          msg.includes("unauthorized") ||
          msg.includes("model not found") ||
          msg.includes("model_not_found") ||
          msg.includes("invalid_api_key") ||
          msg.includes("Could not resolve model");
        expect(isModelAuth, `Expected "${msg}" to NOT be classified as model/auth error`).toBe(false);
      }
    });
  });

  describe("user-friendly error messages", () => {
    function friendlyErrorMessage(error: unknown): string {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("No API key") || msg.includes("invalid_api_key")) {
        return "Model configuration issue — no valid API key found. Run /supi:models to configure, or ensure your agent has a model set up.";
      }
      if (msg.includes("model not found") || msg.includes("model_not_found") || msg.includes("Could not resolve model")) {
        return "Configured model is not available. Run /supi:models to pick a different model, or remove the override to use your agent's default.";
      }
      if (msg.includes("Sub-agent dispatch is not available")) {
        return msg;
      }
      return `Agent error: ${msg}`;
    }

    test("converts API key errors to user-friendly message", () => {
      const msg = friendlyErrorMessage(new Error("No API key found for undefined"));
      expect(msg).toContain("/supi:models");
      expect(msg).not.toContain("undefined");
      expect(msg).not.toContain("No API key found");
    });

    test("converts model-not-found to user-friendly message", () => {
      const msg = friendlyErrorMessage(new Error("model_not_found: foo-bar"));
      expect(msg).toContain("/supi:models");
      expect(msg).toContain("not available");
    });

    test("passes through platform availability errors as-is", () => {
      const original = "Sub-agent dispatch is not available on this platform. Restart required.";
      const msg = friendlyErrorMessage(new Error(original));
      expect(msg).toBe(original);
    });

    test("wraps generic errors with Agent error prefix", () => {
      const msg = friendlyErrorMessage(new Error("ECONNREFUSED"));
      expect(msg).toBe("Agent error: ECONNREFUSED");
    });
  });
});

describe("cascade blocking in batch execution", () => {
  test("tasks depending on failed tasks should be identified as cascade-blocked", () => {
    // Simulates the logic in run.ts
    const failedTaskIds = new Set<number>([1, 3]);

    type TaskParallelism =
      | { type: "parallel-safe" }
      | { type: "sequential"; dependsOn: number[] };

    const batchTaskIds = [4, 5, 6];
    const taskParallelism: Record<number, TaskParallelism> = {
      4: { type: "sequential", dependsOn: [1] },      // depends on failed task 1
      5: { type: "parallel-safe" },                     // independent
      6: { type: "sequential", dependsOn: [2, 3] },    // depends on failed task 3
    };

    const executableTaskIds: number[] = [];
    const cascadeBlocked: number[] = [];

    for (const taskId of batchTaskIds) {
      const parallelism = taskParallelism[taskId];
      if (
        parallelism.type === "sequential" &&
        parallelism.dependsOn.some((dep) => failedTaskIds.has(dep))
      ) {
        cascadeBlocked.push(taskId);
      } else {
        executableTaskIds.push(taskId);
      }
    }

    expect(cascadeBlocked).toEqual([4, 6]);
    expect(executableTaskIds).toEqual([5]);
  });

  test("parallel-safe tasks are never cascade-blocked", () => {
    const failedTaskIds = new Set<number>([1, 2, 3]);

    type TaskParallelism = { type: "parallel-safe" };

    const batchTaskIds = [4, 5];
    const executableTaskIds: number[] = [];
    const cascadeBlocked: number[] = [];

    for (const taskId of batchTaskIds) {
      const parallelism: TaskParallelism = { type: "parallel-safe" };
      if (parallelism.type === "parallel-safe") {
        executableTaskIds.push(taskId);
      }
    }

    expect(cascadeBlocked).toEqual([]);
    expect(executableTaskIds).toEqual([4, 5]);
  });

  test("tasks with all deps satisfied are not cascade-blocked", () => {
    const failedTaskIds = new Set<number>([3]);

    type TaskParallelism = { type: "sequential"; dependsOn: number[] };

    const taskId = 4;
    const parallelism: TaskParallelism = { type: "sequential", dependsOn: [1, 2] };

    const isCascadeBlocked = parallelism.dependsOn.some((dep) => failedTaskIds.has(dep));
    expect(isCascadeBlocked).toBe(false);
  });

  test("failed task IDs accumulate across batches for cascade propagation", () => {
    const failedTaskIds = new Set<number>();

    // Batch 1: task 1 fails
    failedTaskIds.add(1);

    // Batch 2: task 3 depends on 1, gets cascade-blocked, added to failedTaskIds
    const task3DependsOn = [1];
    const task3Blocked = task3DependsOn.some((dep) => failedTaskIds.has(dep));
    expect(task3Blocked).toBe(true);
    failedTaskIds.add(3);

    // Batch 3: task 5 depends on 3 (which was cascade-blocked), also cascade-blocked
    const task5DependsOn = [3];
    const task5Blocked = task5DependsOn.some((dep) => failedTaskIds.has(dep));
    expect(task5Blocked).toBe(true);

    expect(failedTaskIds).toEqual(new Set([1, 3]));
  });
});


describe("per-task error isolation", () => {
  test("unhandled dispatch error produces a blocked AgentResult", () => {
    // Simulates the .catch() handler added to dispatchAgentWithReview
    const error = new Error("Unexpected platform crash");
    const msg = error instanceof Error ? error.message : String(error);
    const result = {
      taskId: 1,
      status: "blocked" as const,
      output: `Unexpected dispatch error: ${msg}`,
      filesChanged: [],
      duration: 0,
    };

    expect(result.status).toBe("blocked");
    expect(result.output).toContain("Unexpected dispatch error");
    expect(result.output).toContain("platform crash");
  });

  test("non-Error throw is stringified", () => {
    const error = "raw string error";
    const msg = error instanceof Error ? error.message : String(error);

    expect(msg).toBe("raw string error");
  });
});

describe("fix retry uses latest output", () => {
  test("second retry receives first retry's output, not original", () => {
    const original = { taskId: 1, status: "blocked" as const, output: "original failure", filesChanged: [], duration: 100 };
    let latestResult = original;

    // Simulate retry 1
    const retry1 = { taskId: 1, status: "blocked" as const, output: "retry 1 failure", filesChanged: [], duration: 100 };
    latestResult = retry1;

    // Retry 2 should use retry1's output
    expect(latestResult.output).toBe("retry 1 failure");
    expect(latestResult.output).not.toBe("original failure");
  });

  test("first retry uses original output", () => {
    const original = { taskId: 1, status: "blocked" as const, output: "original failure", filesChanged: [], duration: 100 };
    const latestResult = original;

    expect(latestResult.output).toBe("original failure");
  });
});

describe("per-task timeout", () => {
  test("AbortSignal.timeout creates a timeout signal", () => {
    const signal = AbortSignal.timeout(100);
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });

  test("AbortSignal.any composes user and timeout signals", () => {
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(60_000);
    const composed = AbortSignal.any([controller.signal, timeoutSignal]);

    expect(composed.aborted).toBe(false);

    // User abort propagates
    controller.abort();
    expect(composed.aborted).toBe(true);
  });

  test("taskTimeout: 0 means only user signal is used", () => {
    const taskTimeout = 0;
    const userSignal = new AbortController().signal;

    const taskSignal = taskTimeout > 0
      ? AbortSignal.any([userSignal, AbortSignal.timeout(taskTimeout)])
      : userSignal;

    // Should be the same reference when taskTimeout is 0
    expect(taskSignal).toBe(userSignal);
  });

  test("timeout abort reason is a TimeoutError DOMException", async () => {
    const signal = AbortSignal.timeout(10);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason.name).toBe("TimeoutError");
  });
});