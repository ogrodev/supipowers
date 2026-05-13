import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runUltraPlanBatchSupervisor, resumeUltraPlanBatchSupervisor } from "../../../src/ultraplan/batch/supervisor.js";
import { renderUltraPlanBatchSummary } from "../../../src/ultraplan/batch/presenter.js";
import { saveUltraPlanBatchRun, loadUltraPlanBatchRun } from "../../../src/ultraplan/batch/storage.js";
import { createTestPaths, createTestRepo, makeUltraPlanBatchNode, makeUltraPlanBatchRunWithNodes } from "../fixtures.js";

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-batch-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("ultraplan batch integration", () => {
  test("launches two independent sessions and merges them cleanly across serialized merge passes", async () => {
    let mergeCounter = 0;
    let run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 0 }),
    ], { state: "running", maxParallelism: 2 });

    run = await runUltraPlanBatchSupervisor({
      run,
      deps: {
        computeFrontier: (current) => current.nodes.filter((node) => node.state === "pending"),
        runWorker: async () => ({ kind: "completed", session: { state: "complete" } as any }),
        mergeNode: () => ({
          kind: "merged",
          currentBaseHead: `sha-merged-${++mergeCounter}`,
          worktreePath: null,
          cleanupWarning: null,
          countsAgainstParallelism: false,
        }),
      },
    });
    run = await runUltraPlanBatchSupervisor({ run, deps: { mergeNode: () => ({ kind: "merged", currentBaseHead: `sha-merged-${++mergeCounter}`, worktreePath: null, cleanupWarning: null, countsAgainstParallelism: false }), runWorker: async () => null, computeFrontier: () => [] } });
    run = await runUltraPlanBatchSupervisor({ run, deps: { mergeNode: () => ({ kind: "merged", currentBaseHead: `sha-merged-${++mergeCounter}`, worktreePath: null, cleanupWarning: null, countsAgainstParallelism: false }), runWorker: async () => null, computeFrontier: () => [] } });

    expect(run.nodes.map((node) => node.state)).toEqual(["merged", "merged"]);
    expect(run.state).toBe("complete");
  });

  test("lets unrelated work proceed when another worker blocks", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-blocked", sessionId: "up-blocked", waveIndex: 0, state: "blocked", blockerKind: "session", blockerSummary: "blocked" }),
      makeUltraPlanBatchNode({ nodeId: "node-free", sessionId: "up-free", waveIndex: 1 }),
      makeUltraPlanBatchNode({ nodeId: "node-dependent", sessionId: "up-dependent", waveIndex: 1, dependencies: ["up-blocked"] }),
    ], { state: "running" });

    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: { runWorker: async () => null },
    });

    expect(next.nodes.find((node) => node.sessionId === "up-free")?.state).toBe("running");
    expect(next.nodes.find((node) => node.sessionId === "up-dependent")?.state).toBe("pending");
  });

  test("blocks dependents after a merge-blocked node while unrelated work can continue", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
      makeUltraPlanBatchNode({ nodeId: "node-dependent", sessionId: "up-dependent", waveIndex: 1, dependencies: ["up-merge"] }),
      makeUltraPlanBatchNode({ nodeId: "node-free", sessionId: "up-free", waveIndex: 1 }),
    ], { state: "running" });

    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: {
        mergeNode: () => ({ kind: "blocked", code: "merge-blocked", currentBaseHead: "sha-base", worktreePath: "/repo/.worktrees/up-merge", summary: "Manual merge required", countsAgainstParallelism: false }),
        runWorker: async () => null,
      },
    });

    expect(next.nodes.find((node) => node.sessionId === "up-merge")?.state).toBe("blocked");
    expect(next.nodes.find((node) => node.sessionId === "up-dependent")?.state).toBe("blocked");
    expect(next.nodes.find((node) => node.sessionId === "up-free")?.state).toBe("running");
  });

  test("preserves awaiting-user worktrees and reports them in summaries", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-await", sessionId: "up-await", waveIndex: 0, worktreePath: "/repo/.worktrees/up-await" }),
    ], { state: "running" });

    const next = await runUltraPlanBatchSupervisor({
      run,
      deps: {
        runWorker: async () => ({ kind: "paused", session: { state: "awaiting-user", blocker: { message: "Need human input" } } as any }),
      },
    });

    expect(next.nodes[0]?.state).toBe("awaiting-user");
    expect(renderUltraPlanBatchSummary(next)).toContain("Kept worktrees: /repo/.worktrees/up-await");
  });

  test("blocks further auto-merge on resume when the supervisor base has drifted", async () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merge", sessionId: "up-merge", waveIndex: 0, state: "merge-pending" }),
    ], { state: "running" });

    const next = await resumeUltraPlanBatchSupervisor({
      run,
      deps: {
        mergeNode: () => ({ kind: "blocked", code: "base-drift", currentBaseHead: "sha-base", worktreePath: "/repo/.worktrees/up-merge", summary: "Supervisor branch advanced from sha-base to sha-drifted before merge.", countsAgainstParallelism: false }),
      },
    });

    expect(next.state).toBe("blocked");
    expect(next.batchBlockerCode).toBe("base-drift");
  });

  test("reconciles persisted restart state before resuming scheduling", async () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot: cwd } = createTestRepo(tmpDir, `repo-${Date.now()}`);
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" }),
      makeUltraPlanBatchNode({ nodeId: "node-pending", sessionId: "up-pending", waveIndex: 0 }),
    ], { runId: `batch-restart-${Date.now()}`, state: "running" });

    expect(saveUltraPlanBatchRun(paths, cwd, run).ok).toBe(true);
    const loaded = loadUltraPlanBatchRun(paths, cwd, run.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const resumed = await resumeUltraPlanBatchSupervisor({
      run: loaded.value,
      deps: { computeFrontier: () => [], runWorker: async () => null },
    });

    expect(resumed.nodes.find((node) => node.sessionId === "up-running")?.state).toBe("blocked");
  });

  test("renders mixed paused, merged, and abandoned outcomes coherently", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-merged", sessionId: "up-merged", waveIndex: 0, state: "merged" }),
      makeUltraPlanBatchNode({ nodeId: "node-paused", sessionId: "up-paused", waveIndex: 0, state: "blocked", blockerKind: "session", blockerSummary: "waiting" }),
      makeUltraPlanBatchNode({ nodeId: "node-abandoned", sessionId: "up-abandoned", waveIndex: 0, state: "abandoned" }),
    ], { state: "paused" });

    const summary = renderUltraPlanBatchSummary(run);
    expect(summary).toContain("Batch state: paused");
    expect(summary).toContain("Active wave: 0");
  });
});
