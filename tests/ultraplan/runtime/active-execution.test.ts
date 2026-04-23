import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindActiveUltraPlanExecution,
  clearActiveUltraPlanExecution,
  clearMatchedActiveUltraPlanExecution,
  listActiveUltraPlanExecutions,
  readActiveUltraPlanExecution,
  readActiveUltraPlanExecutionForAttempt,
  readActiveUltraPlanExecutionForCwd,
  readActiveUltraPlanExecutionForSession,
} from "../../../src/ultraplan/runtime/active-execution.js";
import { makeActiveUltraPlanExecution } from "../fixtures.js";

beforeEach(() => {
  clearActiveUltraPlanExecution();
});

afterEach(() => {
  clearActiveUltraPlanExecution();
});

describe("ultraplan active execution", () => {
  test("bind then read returns the same execution when only one worker is active", () => {
    const execution = makeActiveUltraPlanExecution();

    bindActiveUltraPlanExecution(execution);

    expect(readActiveUltraPlanExecution()).toEqual(execution);
  });

  test("binds two active workers at once", () => {
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

    bindActiveUltraPlanExecution(first);
    bindActiveUltraPlanExecution(second);

    expect(listActiveUltraPlanExecutions()).toEqual([first, second]);
  });

  test("global reads fail closed when more than one worker is active", () => {
    const first = makeActiveUltraPlanExecution({ sessionId: "up-123", cwd: "/repo/one" });
    const second = makeActiveUltraPlanExecution({ sessionId: "up-456", cwd: "/repo/two" });

    bindActiveUltraPlanExecution(first);
    bindActiveUltraPlanExecution(second);

    expect(readActiveUltraPlanExecution()).toBeNull();
    expect(readActiveUltraPlanExecutionForCwd("/repo/one")).toEqual(first);
    expect(readActiveUltraPlanExecutionForCwd("/repo/two")).toEqual(second);
  });

  test("reads one worker by session and cwd", () => {
    const first = makeActiveUltraPlanExecution({ sessionId: "up-123", cwd: "/repo/one" });
    const second = makeActiveUltraPlanExecution({ sessionId: "up-456", cwd: "/repo/two" });

    bindActiveUltraPlanExecution(first);
    bindActiveUltraPlanExecution(second);

    expect(readActiveUltraPlanExecutionForSession("up-123", "/repo/one")).toEqual(first);
    expect(readActiveUltraPlanExecutionForSession("up-456", "/repo/two")).toEqual(second);
  });

  test("looks up an active worker by exact attempt identity", () => {
    const first = makeActiveUltraPlanExecution({
      sessionId: "up-123",
      cwd: "/repo/one",
      launchContext: { ...makeActiveUltraPlanExecution().launchContext, attemptId: "att-001" },
    });
    const second = makeActiveUltraPlanExecution({
      sessionId: "up-123",
      cwd: "/repo/one",
      launchContext: { ...makeActiveUltraPlanExecution().launchContext, attemptId: "att-002" },
    });

    bindActiveUltraPlanExecution(first);
    bindActiveUltraPlanExecution(second);

    expect(readActiveUltraPlanExecutionForAttempt("up-123", "/repo/one", "att-001")).toEqual(first);
    expect(readActiveUltraPlanExecutionForAttempt("up-123", "/repo/one", "att-002")).toEqual(second);
  });

  test("clears only one active worker without wiping the rest", () => {
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

    bindActiveUltraPlanExecution(first);
    bindActiveUltraPlanExecution(second);
    clearMatchedActiveUltraPlanExecution(first.sessionId, first.cwd, first.launchContext.attemptId);

    expect(readActiveUltraPlanExecutionForAttempt(first.sessionId, first.cwd, first.launchContext.attemptId)).toBeNull();
    expect(readActiveUltraPlanExecutionForAttempt(second.sessionId, second.cwd, second.launchContext.attemptId)).toEqual(second);
    expect(listActiveUltraPlanExecutions()).toEqual([second]);
  });
});
