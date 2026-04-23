import { describe, expect, test } from "bun:test";
import {
  buildUltraPlanBatchRunGraph,
  computeUltraPlanBatchEligibleFrontier,
} from "../../../src/ultraplan/batch/planner.js";
import {
  makeUltraPlanBatchNode,
  makeUltraPlanBatchRunWithNodes,
} from "../fixtures.js";

describe("ultraplan batch planner", () => {
  test("rejects duplicate session ids", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-1", waveIndex: 1 }),
    ]);

    expect(() => buildUltraPlanBatchRunGraph(run)).toThrow(/duplicate batch sessionId up-1/);
  });

  test("rejects waves that omit persisted nodes or reference unknown sessions", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 1 }),
    ], {
      waves: [
        { waveIndex: 0, sessionIds: ["up-1"] },
        { waveIndex: 1, sessionIds: ["up-3"] },
      ],
    });

    expect(() => buildUltraPlanBatchRunGraph(run)).toThrow(/missing from wave 1|unknown session up-3/);
  });

  test("rejects wave membership that disagrees with node.waveIndex", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 1 }),
    ], {
      waves: [
        { waveIndex: 0, sessionIds: ["up-1", "up-2"] },
        { waveIndex: 1, sessionIds: [] },
      ],
    });

    expect(() => buildUltraPlanBatchRunGraph(run)).toThrow(/includes up-2, but the node is assigned to wave 1/);
  });

  test("rejects dependencies that point into a later wave", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0, dependencies: ["up-2"] }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 1 }),
    ]);

    expect(() => buildUltraPlanBatchRunGraph(run)).toThrow(/later wave/);
  });

  test("accepts same-wave dependencies when the graph remains acyclic", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 0, dependencies: ["up-1"] }),
    ]);

    expect(() => buildUltraPlanBatchRunGraph(run)).not.toThrow();
  });

  test("rejects dependency cycles", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-1", sessionId: "up-1", waveIndex: 0, dependencies: ["up-2"] }),
      makeUltraPlanBatchNode({ nodeId: "node-2", sessionId: "up-2", waveIndex: 0, dependencies: ["up-1"] }),
    ]);

    expect(() => buildUltraPlanBatchRunGraph(run)).toThrow(/cycle/i);
  });

  test("uses persisted nodes[] order as the tiebreaker within one wave", () => {
    const run = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ nodeId: "node-b", sessionId: "up-b", waveIndex: 0 }),
      makeUltraPlanBatchNode({ nodeId: "node-a", sessionId: "up-a", waveIndex: 0 }),
    ]);

    const frontier = computeUltraPlanBatchEligibleFrontier(run);
    expect(frontier.map((node) => node.sessionId)).toEqual(["up-b", "up-a"]);
  });

  test("auto-unblocks dependency-blocked nodes once prerequisites merge", () => {
    const merged = makeUltraPlanBatchNode({
      nodeId: "node-1",
      sessionId: "up-1",
      waveIndex: 0,
      state: "merged",
    });
    const dependencyBlocked = makeUltraPlanBatchNode({
      nodeId: "node-2",
      sessionId: "up-2",
      waveIndex: 1,
      dependencies: ["up-1"],
      state: "blocked",
      blockerKind: "dependency",
      blockerSummary: "Waiting for up-1 to merge",
    });

    const readyRun = makeUltraPlanBatchRunWithNodes([merged, dependencyBlocked]);
    expect(computeUltraPlanBatchEligibleFrontier(readyRun).map((node) => node.sessionId)).toEqual(["up-2"]);

    const blockedRun = makeUltraPlanBatchRunWithNodes([
      makeUltraPlanBatchNode({ ...merged, state: "running" }),
      dependencyBlocked,
    ]);
    expect(computeUltraPlanBatchEligibleFrontier(blockedRun)).toEqual([]);
  });
});
