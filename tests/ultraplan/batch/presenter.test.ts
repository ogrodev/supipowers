import { describe, expect, test } from "bun:test";
import {
  renderUltraPlanBatchNodeSummary,
  renderUltraPlanBatchSummary,
} from "../../../src/ultraplan/batch/presenter.js";
import {
  makeUltraPlanBatchJournalEvent,
  makeUltraPlanBatchNode,
  makeUltraPlanBatchRunWithNodes,
} from "../fixtures.js";

describe("ultraplan batch presenter", () => {
  test("renders the active wave and frontier for a running batch", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-running", sessionId: "up-running", waveIndex: 0, state: "running" }),
      makeUltraPlanBatchNode({ nodeId: "node-ready", sessionId: "up-ready", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-later", sessionId: "up-later", waveIndex: 1, dependencies: ["up-running"] }),
    ], { state: "running" });

    const summary = renderUltraPlanBatchSummary(run);
    expect(summary).toContain("Active wave: 0");
    expect(summary).toContain("Frontier: up-ready");
  });

  test("renders blocked batch summaries with the batch blocker code", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0, state: "blocked", blockerKind: "supervisor", blockerSummary: "base drift" }),
    ], {
      state: "blocked",
      batchBlockerCode: "base-drift",
      batchBlockerSummary: "Supervisor branch advanced before merge.",
    });

    const summary = renderUltraPlanBatchSummary(run);
    expect(summary).toContain("Batch blocked: base-drift");
    expect(summary).toContain("Supervisor branch advanced before merge.");
  });

  test("renders running workers and kept worktrees for resume surfaces", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({
        nodeId: "node-running",
        sessionId: "up-running",
        waveIndex: 0,
        state: "running",
        worktreePath: "/repo/.worktrees/batch-123-up-running",
      }),
      makeUltraPlanBatchNode({
        nodeId: "node-merged",
        sessionId: "up-merged",
        waveIndex: 0,
        state: "merged",
        worktreePath: "/repo/.worktrees/batch-123-up-merged",
      }),
    ], { state: "running" });

    const summary = renderUltraPlanBatchSummary(run);
    expect(summary).toContain("Running workers: up-running");
    expect(summary).toContain("Kept worktrees: /repo/.worktrees/batch-123-up-running, /repo/.worktrees/batch-123-up-merged");
  });

  test("explains paused dependency-blocked and later-wave nodes", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-upstream", sessionId: "up-upstream", waveIndex: 0, state: "blocked", blockerKind: "merge", blockerSummary: "merge blocked" }),
      makeUltraPlanBatchNode({
        nodeId: "node-dependent",
        sessionId: "up-dependent",
        waveIndex: 1,
        dependencies: ["up-upstream"],
        state: "blocked",
        blockerKind: "dependency",
        blockerSummary: "waiting for up-upstream",
      }),
      makeUltraPlanBatchNode({ nodeId: "node-later", sessionId: "up-later", waveIndex: 2, dependencies: ["up-dependent"] }),
    ], { state: "paused" });

    const summary = renderUltraPlanBatchSummary(run);
    expect(summary).toContain("up-dependent is waiting for dependencies: up-upstream");
    expect(summary).toContain("Later wave queued: up-later becomes eligible after up-dependent merges.");
  });

  test("derives merged cleanup warnings from kept worktree journal events", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({
        nodeId: "node-merged",
        sessionId: "up-merged",
        waveIndex: 0,
        state: "merged",
        worktreePath: "/repo/.worktrees/batch-123-up-merged",
      }),
    ], { state: "complete" });
    const journal = [
      makeUltraPlanBatchJournalEvent({
        sessionId: "up-merged",
        type: "cleanup-warning",
        summary: "Unable to remove worktree directory",
      }),
    ];

    const nodeSummary = renderUltraPlanBatchNodeSummary(run.nodes[0]!, run, journal);
    expect(nodeSummary).toContain("merged with cleanup warning");
    expect(nodeSummary).toContain("Unable to remove worktree directory");
  });
});
