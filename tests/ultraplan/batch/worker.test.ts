import { describe, expect, test } from "bun:test";
import { runUltraPlanBatchWorker } from "../../../src/ultraplan/batch/worker.js";

describe("ultraplan batch worker", () => {
  test("invokes runUltraPlanSession with the prepared worktree cwd", async () => {
    const calls: Array<{ cwd: string; sessionId: string }> = [];

    await runUltraPlanBatchWorker({
      platform: {} as any,
      sessionId: "up-123",
      worktreeCwd: "/repo/.worktrees/batch-123-up-123",
      deps: {
        runSession: async (input) => {
          calls.push({ cwd: input.cwd, sessionId: input.sessionId });
          return { kind: "paused", session: { sessionId: input.sessionId } as any };
        },
      },
    });

    expect(calls).toEqual([{ cwd: "/repo/.worktrees/batch-123-up-123", sessionId: "up-123" }]);
  });

  test("passes through completed and paused worker outcomes without mutating them", async () => {
    const completed = { kind: "completed", session: { sessionId: "up-complete", state: "complete" } as any } as const;
    const paused = { kind: "paused", session: { sessionId: "up-paused", state: "blocked" } as any } as const;

    expect(
      await runUltraPlanBatchWorker({
        platform: {} as any,
        sessionId: "up-complete",
        worktreeCwd: "/repo/.worktrees/batch-123-up-complete",
        deps: { runSession: async () => completed },
      }),
    ).toBe(completed);

    expect(
      await runUltraPlanBatchWorker({
        platform: {} as any,
        sessionId: "up-paused",
        worktreeCwd: "/repo/.worktrees/batch-123-up-paused",
        deps: { runSession: async () => paused },
      }),
    ).toBe(paused);
  });
});
