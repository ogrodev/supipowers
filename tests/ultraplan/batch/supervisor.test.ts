import { describe, expect, test } from "bun:test";
import { makeUltraPlanBatchNode, makeUltraPlanBatchRunWithNodes } from "../fixtures.js";
import {
  abandonUltraPlanBatchNode,
  abandonUltraPlanBatchRun,
  resumeUltraPlanBatchSupervisor,
  runUltraPlanBatchSupervisor,
  type UltraPlanBatchSupervisorDeps,
} from "../../../src/ultraplan/batch/supervisor.js";
import { computeUltraPlanBatchEligibleFrontier } from "../../../src/ultraplan/batch/planner.js";

function makeDeps(overrides: Partial<UltraPlanBatchSupervisorDeps> = {}): UltraPlanBatchSupervisorDeps {
  return {
    computeFrontier: computeUltraPlanBatchEligibleFrontier,
    runWorker: async () => null,
    mergeNode: () => null,
    ...overrides,
  };
}

describe("ultraplan batch supervisor", () => {
  test("launches only up to maxParallelism workers from the eligible frontier", async () => {
    const workerCalls: string[] = [];
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-3", sessionId: "up-3", waveIndex: 0 }),
    ], { maxParallelism: 2 });

    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        runWorker: async (node) => {
          workerCalls.push(node.sessionId);
          return null;
        },
      }),
    });

    expect(workerCalls).toEqual(["up-1", "up-2"]);
    expect(next.nodes.map((node) => node.state)).toEqual(["running", "running", "pending"]);
    expect(next.state).toBe("running");
  });

  test("starts eligible frontier workers concurrently up to maxParallelism", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 0 }),
    ], { maxParallelism: 2 });
    const workerCalls: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });

    const nextPromise = runUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        runWorker: async (node) => {
          workerCalls.push(node.sessionId);
          if (workerCalls.length === 2) {
            startedResolve();
          }
          return new Promise((resolve) => {
            if (node.sessionId === "up-1") {
              releaseFirst = () => resolve(null);
            } else {
              releaseSecond = () => resolve(null);
            }
          });
        },
      }),
    });

    await started;
    expect(workerCalls).toEqual(["up-1", "up-2"]);

    releaseFirst();
    releaseSecond();
    const next = await nextPromise;
    expect(next.nodes.map((node) => node.state)).toEqual(["running", "running"]);
  });

  test("lets unrelated work proceed while blocked siblings hold only their dependents", async () => {
    const workerCalls: string[] = [];
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({
        nodeId: "node-a",
        sessionId: "up-a",
        waveIndex: 0,
        state: "blocked",
        blockerKind: "merge",
        blockerSummary: "merge blocked",
      }),
      makeUltraPlanBatchNode({ nodeId: "node-b", sessionId: "up-b", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-c", sessionId: "up-c", waveIndex: 1, dependencies: ["up-a"] }),
    ]);

    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        runWorker: async (node) => {
          workerCalls.push(node.sessionId);
          return null;
        },
      }),
    });

    expect(workerCalls).toEqual(["up-b"]);
    expect(next.nodes.find((node) => node.sessionId === "up-b")?.state).toBe("running");
    expect(next.nodes.find((node) => node.sessionId === "up-c")?.state).toBe("pending");
  });

  test("transitions a batch from paused to blocked when a supervisor invariant is discovered", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
    ], { state: "paused", batchResumeRequestedAt: "2026-04-21T12:00:00.000Z" });
    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        mergeNode: () => ({
          kind: "blocked",
          code: "base-drift",
          currentBaseHead: "sha-base",
          worktreePath: "/repo/.worktrees/batch-up-merge",
          summary: "Supervisor branch advanced from sha-base to sha-drifted before merge.",
          countsAgainstParallelism: false,
        }),
      }),
    });

    expect(next.state).toBe("blocked");
    expect(next.batchBlockerCode).toBe("base-drift");
    expect(next.nodes[0]?.state).toBe("blocked");
  });

  test("stops new launches once the batch is blocked but still drains running workers into stable states", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
      makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" }),
      makeUltraPlanBatchNode({ nodeId: "node-pending", sessionId: "up-pending", waveIndex: 0 }),
    ], { state: "running" });
    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        mergeNode: () => ({
          kind: "blocked",
          code: "supervisor-worktree-invalid",
          currentBaseHead: "sha-base",
          worktreePath: "/repo/.worktrees/batch-up-merge",
          summary: "Supervisor worktree HEAD is detached.",
          countsAgainstParallelism: false,
        }),
        runWorker: async () => ({
          kind: "paused",
          session: {
            sessionId: "up-running",
            state: "blocked",
            blocker: { message: "worker blocked" },
          } as any,
        }),
      }),
    });

    expect(next.state).toBe("blocked");
    expect(next.batchBlockerCode).toBe("supervisor-worktree-invalid");
    expect(next.nodes.find((node) => node.sessionId === "up-running")?.state).toBe("blocked");
    expect(next.nodes.find((node) => node.sessionId === "up-pending")?.state).toBe("pending");
  });

  test("rejects illegal state transitions before scheduling continues", async () => {
    const blockedComplete = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merged", sessionId: "up-merged", waveIndex: 0, state: "merged" }),
    ], { state: "blocked", batchResumeRequestedAt: null });

    await expect(runUltraPlanBatchSupervisor({ run: blockedComplete, deps: makeDeps() })).rejects.toThrow(
      /blocked batch cannot complete without resume approval/i,
    );

    const pausedMergePending = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
    ], { state: "paused", batchResumeRequestedAt: null });

    await expect(runUltraPlanBatchSupervisor({ run: pausedMergePending, deps: makeDeps() })).rejects.toThrow(
      /paused batch cannot enter merge-pending without resume approval/i,
    );
  });

  test("serializes merge attempts through one supervisor workspace", async () => {
    const mergeCalls: string[] = [];
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0, state: "merge-pending" }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 0, state: "merge-pending" }),
    ], { state: "running" });
    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        mergeNode: (node) => {
          mergeCalls.push(node.sessionId);
          return {
            kind: "merged",
            currentBaseHead: "sha-merged-1",
            worktreePath: null,
            cleanupWarning: null,
            countsAgainstParallelism: false,
          };
        },
      }),
    });

    expect(mergeCalls).toEqual(["up-1"]);
    expect(next.nodes.find((node) => node.sessionId === "up-1")?.state).toBe("merged");
    expect(next.nodes.find((node) => node.sessionId === "up-2")?.state).toBe("merge-pending");
  });

  test("reconciles preparing, running, and merge-pending nodes before resume scheduling continues", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-preparing", sessionId: "up-preparing", waveIndex: 0, state: "preparing" }),
      makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" }),
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
    ], { state: "running" });

    const next = await resumeUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        computeFrontier: () => [],
        mergeNode: () => ({
          kind: "merged",
          currentBaseHead: "sha-resumed-merge",
          worktreePath: null,
          cleanupWarning: null,
          countsAgainstParallelism: false,
        }),
      }),
    });

    expect(next.nodes.find((node) => node.sessionId === "up-preparing")?.state).toBe("pending");
    expect(next.nodes.find((node) => node.sessionId === "up-running")?.state).toBe("blocked");
    expect(next.nodes.find((node) => node.sessionId === "up-merge")?.state).toBe("merged");
    expect(next.nodes.some((node) => node.state === "preparing" || node.state === "running")).toBe(false);
  });

  test("fails closed on restarted running workers instead of blindly relaunching them", async () => {
    let workerCalls = 0;
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" }),
    ], { state: "running" });

    const next = await resumeUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({
        runWorker: async () => {
          workerCalls += 1;
          return null;
        },
      }),
    });

    expect(workerCalls).toBe(0);
    expect(next.nodes[0]?.state).toBe("blocked");
  });

  test("auto-unblocks dependency-blocked nodes after an upstream merge on resume", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-upstream", sessionId: "up-upstream", waveIndex: 0, state: "merged" }),
      makeUltraPlanBatchNode({
        nodeId: "node-dependent",
        sessionId: "up-dependent",
        waveIndex: 1,
        dependencies: ["up-upstream"],
        state: "blocked",
        blockerKind: "dependency",
        blockerSummary: "waiting for merge",
      }),
    ], { state: "paused", batchResumeRequestedAt: "2026-04-21T12:30:00.000Z" });

    const next = await resumeUltraPlanBatchSupervisor({
      run,
      deps: makeDeps({ runWorker: async () => null }),
    });

    expect(next.nodes.find((node) => node.sessionId === "up-dependent")?.state).toBe("running");
  });

  test("refuses node or batch abandonment while work is still in flight", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" }),
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
    ], { state: "running" });

    expect(() => abandonUltraPlanBatchNode(run, "up-running")).toThrow(/in flight/i);
    expect(() => abandonUltraPlanBatchRun(run)).toThrow(/in flight/i);
  });
});
