import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createPaths } from "../../src/platform/types.js";

const handleAiReview = mock();
const registerAiReviewCommand = mock();

mock.module("../../src/commands/ai-review.js", () => ({
  handleAiReview,
  registerAiReviewCommand,
}));

describe("bootstrap input interception", () => {
  beforeEach(() => {
    handleAiReview.mockReset();
    registerAiReviewCommand.mockReset();
  });

  test("forwards /supi:review args to the intercepted TUI handler", async () => {
    const { bootstrap } = await import("../../src/bootstrap.js");
    const platform = {
      name: "omp",
      registerCommand: mock(),
      getCommands: mock(() => []),
      getActiveTools: mock(() => []),
      exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
      sendMessage: mock(),
      sendUserMessage: mock(),
      registerMessageRenderer: mock(),
      createAgentSession: mock(),
      on: mock(),
      registerTool: undefined,
      paths: createPaths(".omp"),
      capabilities: {
        agentSessions: true,
        compactionHooks: false,
        customWidgets: true,
        registerTool: false,
      },
    } as any;

    bootstrap(platform);

    const inputHandler = platform.on.mock.calls.find((call: any[]) => call[0] === "input")?.[1];
    expect(inputHandler).toBeDefined();

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: { notify: mock() },
      modelRegistry: { getAvailable: () => [] },
    } as any;

    const result = inputHandler({ text: "/supi:review --target pkg-a" }, ctx);

    expect(result).toEqual({ action: "handled" });
    expect(handleAiReview).toHaveBeenCalledWith(platform, ctx, "--target pkg-a");
  });
});
