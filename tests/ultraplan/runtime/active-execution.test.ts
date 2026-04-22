import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindActiveUltraPlanExecution,
  clearActiveUltraPlanExecution,
  readActiveUltraPlanExecution,
} from "../../../src/ultraplan/runtime/active-execution.js";
import { makeActiveUltraPlanExecution } from "../fixtures.js";

beforeEach(() => {
  clearActiveUltraPlanExecution();
});

afterEach(() => {
  clearActiveUltraPlanExecution();
});

describe("ultraplan active execution", () => {
  test("bind then read returns the same execution", () => {
    const execution = makeActiveUltraPlanExecution();

    bindActiveUltraPlanExecution(execution);

    expect(readActiveUltraPlanExecution()).toEqual(execution);
  });

  test("clear resets the registry", () => {
    bindActiveUltraPlanExecution(makeActiveUltraPlanExecution());

    clearActiveUltraPlanExecution();

    expect(readActiveUltraPlanExecution()).toBeNull();
  });

  test("rebinding replaces the previous execution", () => {
    const first = makeActiveUltraPlanExecution();
    const second = makeActiveUltraPlanExecution({
      sessionId: "up-456",
      launchContext: { ...makeActiveUltraPlanExecution().launchContext, attemptId: "att-002" },
    });

    bindActiveUltraPlanExecution(first);
    bindActiveUltraPlanExecution(second);

    expect(readActiveUltraPlanExecution()).toEqual(second);
  });
});
