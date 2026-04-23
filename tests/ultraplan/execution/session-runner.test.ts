import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UltraPlanRunOutcome } from "../../../src/ultraplan/execution/session-runner.js";
import { runUltraPlanSession } from "../../../src/ultraplan/execution/session-runner.js";
import {
  clearActiveUltraPlanExecution,
  readActiveUltraPlanExecution,
  readActiveUltraPlanExecutionForAttempt,
} from "../../../src/ultraplan/runtime/active-execution.js";
import { makeActiveUltraPlanExecution } from "../fixtures.js";

beforeEach(() => {
  clearActiveUltraPlanExecution();
});

afterEach(() => {
  clearActiveUltraPlanExecution();
});

function makeSession(state: "blocked" | "awaiting-user" | "complete"): UltraPlanRunOutcome["session"] {
  return {
    sessionId: "up-123",
    projectName: "supipowers",
    title: "Auth slice",
    state,
    createdAt: "2026-04-19T12:00:00.000Z",
    updatedAt: "2026-04-19T12:00:00.000Z",
    cursor: null,
    lastCompleted: null,
    blocker: null,
    progress: { total: 1, terminal: state === "complete" ? 1 : 0, blocked: state === "complete" ? 0 : 1 },
    stacks: [],
    reviews: [],
  };
}

describe("ultraplan session runner", () => {
  test("stops immediately on a pre-existing blocked session", async () => {
    let dispatchCount = 0;

    const result = await runUltraPlanSession({
      platform: {} as any,
      cwd: "/repo",
      sessionId: "up-123",
      deps: {
        resolveRunState: async () => ({ kind: "outcome", outcome: { kind: "paused", session: makeSession("blocked") } }),
        dispatch: async () => {
          dispatchCount += 1;
        },
      },
    });

    expect(result.kind).toBe("paused");
    expect(result.session.state).toBe("blocked");
    expect(dispatchCount).toBe(0);
  });

  test("stops immediately on a pre-existing awaiting-user session", async () => {
    let dispatchCount = 0;

    const result = await runUltraPlanSession({
      platform: {} as any,
      cwd: "/repo",
      sessionId: "up-123",
      deps: {
        resolveRunState: async () => ({ kind: "outcome", outcome: { kind: "paused", session: makeSession("awaiting-user") } }),
        dispatch: async () => {
          dispatchCount += 1;
        },
      },
    });

    expect(result.kind).toBe("paused");
    expect(result.session.state).toBe("awaiting-user");
    expect(dispatchCount).toBe(0);
  });

  test("loops after one dispatch and reloads runtime-owned state before returning", async () => {
    const execution = makeActiveUltraPlanExecution();
    const pausedOutcome: UltraPlanRunOutcome = { kind: "paused", session: makeSession("blocked") };
    let resolveCount = 0;
    let dispatchCount = 0;

    const result = await runUltraPlanSession({
      platform: {} as any,
      cwd: "/repo",
      sessionId: execution.sessionId,
      deps: {
        resolveRunState: async () => {
          resolveCount += 1;
          return resolveCount === 1
            ? { kind: "attempt", execution }
            : { kind: "outcome", outcome: pausedOutcome };
        },
        dispatch: async () => {
          dispatchCount += 1;
          expect(readActiveUltraPlanExecution()).toEqual(execution);
        },
      },
    });

    expect(result).toEqual(pausedOutcome);
    expect(resolveCount).toBe(2);
    expect(dispatchCount).toBe(1);
    expect(readActiveUltraPlanExecution()).toBeNull();
  });

  test("clears the active execution registry when dispatch fails", async () => {
    const execution = makeActiveUltraPlanExecution();
    let seenDuringDispatch: unknown = null;

    try {
      await runUltraPlanSession({
        platform: {} as any,
        cwd: "/repo",
        sessionId: execution.sessionId,
        deps: {
          resolveRunState: async () => ({ kind: "attempt", execution }),
          dispatch: async () => {
            seenDuringDispatch = readActiveUltraPlanExecution();
            throw new Error("dispatch failed");
          },
        },
      });
      throw new Error("expected dispatch to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("dispatch failed");
    }

    expect(seenDuringDispatch).toEqual(execution);
    expect(readActiveUltraPlanExecution()).toBeNull();
  });

  test("keeps overlapping executions discoverable when one worker finishes before the other", async () => {
    const first = makeActiveUltraPlanExecution({
      sessionId: "up-123",
      cwd: "/repo/one",
      launchContext: { ...makeActiveUltraPlanExecution().launchContext, attemptId: "att-001" },
    });
    const second = makeActiveUltraPlanExecution({
      sessionId: "up-456",
      cwd: "/repo/two",
      launchContext: { ...makeActiveUltraPlanExecution().launchContext, attemptId: "att-002" },
    });
    const blockedFirst: UltraPlanRunOutcome = { kind: "paused", session: makeSession("blocked") };
    const blockedSecond: UltraPlanRunOutcome = { kind: "paused", session: { ...makeSession("blocked"), sessionId: second.sessionId } };

    let firstResolveCount = 0;
    let secondResolveCount = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondReady = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let firstDispatchStarted!: () => void;
    let secondDispatchStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstDispatchStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { secondDispatchStarted = resolve; });

    const firstRun = runUltraPlanSession({
      platform: {} as any,
      cwd: first.cwd,
      sessionId: first.sessionId,
      deps: {
        resolveRunState: async () => (++firstResolveCount === 1
          ? { kind: "attempt", execution: first }
          : { kind: "outcome", outcome: blockedFirst }),
        dispatch: async () => {
          firstDispatchStarted();
          expect(readActiveUltraPlanExecutionForAttempt(first.sessionId, first.cwd, first.launchContext.attemptId)).toEqual(first);
          await firstReady;
        },
      },
    });

    const secondRun = runUltraPlanSession({
      platform: {} as any,
      cwd: second.cwd,
      sessionId: second.sessionId,
      deps: {
        resolveRunState: async () => (++secondResolveCount === 1
          ? { kind: "attempt", execution: second }
          : { kind: "outcome", outcome: blockedSecond }),
        dispatch: async () => {
          secondDispatchStarted();
          expect(readActiveUltraPlanExecutionForAttempt(second.sessionId, second.cwd, second.launchContext.attemptId)).toEqual(second);
          await secondReady;
        },
      },
    });

    await Promise.all([firstStarted, secondStarted]);
    expect(readActiveUltraPlanExecutionForAttempt(first.sessionId, first.cwd, first.launchContext.attemptId)).toEqual(first);
    expect(readActiveUltraPlanExecutionForAttempt(second.sessionId, second.cwd, second.launchContext.attemptId)).toEqual(second);

    releaseFirst();
    expect(await firstRun).toEqual(blockedFirst);
    expect(readActiveUltraPlanExecutionForAttempt(first.sessionId, first.cwd, first.launchContext.attemptId)).toBeNull();
    expect(readActiveUltraPlanExecutionForAttempt(second.sessionId, second.cwd, second.launchContext.attemptId)).toEqual(second);

    releaseSecond();
    expect(await secondRun).toEqual(blockedSecond);
    expect(readActiveUltraPlanExecutionForAttempt(second.sessionId, second.cwd, second.launchContext.attemptId)).toBeNull();
  });

  test("returns completed when policy resolves the session as complete", async () => {
    let dispatchCount = 0;

    const result = await runUltraPlanSession({
      platform: {} as any,
      cwd: "/repo",
      sessionId: "up-123",
      deps: {
        resolveRunState: async () => ({ kind: "outcome", outcome: { kind: "completed", session: makeSession("complete") } }),
        dispatch: async () => {
          dispatchCount += 1;
        },
      },
    });

    expect(result.kind).toBe("completed");
    expect(result.session.state).toBe("complete");
    expect(dispatchCount).toBe(0);
  });
});
