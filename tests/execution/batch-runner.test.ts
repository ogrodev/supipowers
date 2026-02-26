import { describe, expect, test } from "vitest";
import { runInBatches } from "../../src/execution/batch-runner";

describe("batch-runner", () => {
  test("runs sequentially in batches with checkpoints", async () => {
    const checkpoints: number[] = [];
    const result = await runInBatches({
      items: [1, 2, 3, 4, 5],
      batchSize: 2,
      runItem: async (value) => value * 10,
      onBatchComplete: ({ completed }) => checkpoints.push(completed),
    });

    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(checkpoints).toEqual([2, 4, 5]);
  });

  test("throws when aborted", async () => {
    const controller = new AbortController();

    await expect(
      runInBatches({
        items: [1, 2, 3],
        batchSize: 1,
        signal: controller.signal,
        runItem: async (value) => {
          if (value === 1) controller.abort();
          return value;
        },
      }),
    ).rejects.toThrow("Execution aborted");
  });
});
