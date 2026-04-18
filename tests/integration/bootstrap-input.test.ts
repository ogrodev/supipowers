import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createPaths } from "../../src/platform/types.js";
import { cancelUiDesignTracking, isUiDesignActive, startUiDesignTracking } from "../../src/ui-design/session.js";

const handleAiReview = mock();
const registerAiReviewCommand = mock();

mock.module("../../src/commands/ai-review.js", () => ({
  handleAiReview,
  registerAiReviewCommand,
}));

function createPlatform() {
  const handlers = new Map<string, any>();
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
    on: mock((name: string, cb: any) => {
      handlers.set(name, cb);
    }),
    registerTool: undefined,
    paths: createPaths(".omp"),
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: true,
      registerTool: false,
    },
  } as any;
  return { platform, handlers };
}

describe("bootstrap input interception", () => {
  beforeEach(() => {
    handleAiReview.mockReset();
    registerAiReviewCommand.mockReset();
    cancelUiDesignTracking("bootstrap-test-reset");
  });

  test("forwards /supi:review args to the intercepted TUI handler", async () => {
    const { bootstrap } = await import("../../src/bootstrap.js");
    const { platform, handlers } = createPlatform();

    bootstrap(platform);

    const inputHandler = handlers.get("input");
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

  test("session_shutdown tears down any active ui-design companion", async () => {
    const { bootstrap } = await import("../../src/bootstrap.js");
    const { platform, handlers } = createPlatform();
    const cleanup = mock(async () => {});

    startUiDesignTracking(
      {
        id: "uidesign-20260418-120000-abcd",
        dir: "/tmp/ui-design-session",
        backend: "local-html",
        companionUrl: "http://localhost:4321",
      },
      cleanup,
    );
    expect(isUiDesignActive()).toBe(true);

    bootstrap(platform);

    const shutdownHandler = handlers.get("session_shutdown");
    expect(shutdownHandler).toBeDefined();

    await shutdownHandler({}, { cwd: process.cwd(), hasUI: true, ui: { notify: mock() } });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(isUiDesignActive()).toBe(false);
  });
});