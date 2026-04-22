import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { registerUltraPlanRuntimeTools } from "../../../src/ultraplan/execution/runtime-tools.js";
import {
  bindActiveUltraPlanExecution,
  clearActiveUltraPlanExecution,
} from "../../../src/ultraplan/runtime/active-execution.js";
import {
  makeActiveUltraPlanExecution,
  makeUltraPlanSignalAwaitUserInput,
  makeUltraPlanSignalBlockInput,
  makeUltraPlanSignalProofInput,
} from "../fixtures.js";

beforeEach(() => {
  clearActiveUltraPlanExecution();
});

afterEach(() => {
  clearActiveUltraPlanExecution();
});

function registerToolDefinition() {
  let definition: any = null;
  const platform = {
    registerTool: mock((value: any) => {
      definition = value;
    }),
  } as any;

  registerUltraPlanRuntimeTools(platform);
  expect(definition?.name).toBe("ultraplan_signal");
  return definition;
}

describe("ultraplan runtime tools", () => {
  test("out-of-run invocation returns an error", async () => {
    const definition = registerToolDefinition();
    const result = await definition.execute(
      "tool-call-1",
      makeUltraPlanSignalProofInput(),
      new AbortController().signal,
      undefined,
      {},
    );

    expect(result.content[0].text.toLowerCase()).toContain("active ultraplan run");
  });

  test("proof signals map details into payload.proof.evidence.metadata", async () => {
    bindActiveUltraPlanExecution(makeActiveUltraPlanExecution());
    const definition = registerToolDefinition();

    const result = await definition.execute(
      "tool-call-1",
      makeUltraPlanSignalProofInput({ details: { command: "bun test", exitCode: 1 } }),
      new AbortController().signal,
      undefined,
      {},
    );

    expect(result.details.payload.proof.evidence.summary).toBe("Tests passed");
    expect(result.details.payload.proof.evidence.metadata).toEqual({ command: "bun test", exitCode: 1 });
  });

  test("block and await-user signals map summary into blocker.message", async () => {
    bindActiveUltraPlanExecution(makeActiveUltraPlanExecution());
    const definition = registerToolDefinition();

    const blockResult = await definition.execute(
      "tool-call-1",
      makeUltraPlanSignalBlockInput({ summary: "Execution blocked by failing proof" }),
      new AbortController().signal,
      undefined,
      {},
    );
    const awaitUserResult = await definition.execute(
      "tool-call-2",
      makeUltraPlanSignalAwaitUserInput({ summary: "Need product sign-off" }),
      new AbortController().signal,
      undefined,
      {},
    );

    expect(blockResult.details.payload.blocker.message).toBe("Execution blocked by failing proof");
    expect(awaitUserResult.details.payload.blocker.message).toBe("Need product sign-off");
  });
});
