import { describe, expect, it, mock, test } from "bun:test";
import supipowers from "../../src/index.js";

function createOmpShapedApi() {
  return {
    registerCommand: mock(),
    getCommands: mock(() => []),
    getActiveTools: mock(() => []),
    exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: mock(),
    registerMessageRenderer: mock(),
    on: mock(),
    pi: {
      createAgentSession: mock(async () => ({
        session: {
          subscribe: mock(() => () => {}),
          prompt: mock(async () => {}),
          state: { messages: [] },
          dispose: mock(async () => {}),
        },
      })),
    },
  };
}

describe("OMP bootstrap", () => {
  it("bootstraps on OMP-shaped API without errors", () => {
    expect(() => supipowers(createOmpShapedApi())).not.toThrow();
  });

  it("registers all expected commands", () => {
    const api = createOmpShapedApi();
    supipowers(api);
    const commandNames = api.registerCommand.mock.calls.map((c: any) => c[0]);
    expect(commandNames).toContain("supi");
    expect(commandNames).toContain("supi:plan");
    expect(commandNames).toContain("supi:review");
    expect(commandNames).toContain("supi:config");
  });

  it("registers input and session_start hooks", () => {
    const api = createOmpShapedApi();
    supipowers(api);
    const events = api.on.mock.calls.map((c: any) => c[0]);
    expect(events).toContain("input");
    expect(events).toContain("session_start");
  });
});
