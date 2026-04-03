import { describe, it, expect, vi } from "vitest";
import supipowers from "../../src/index.js";

function createOmpShapedApi() {
  return {
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => []),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    pi: {
      createAgentSession: vi.fn(async () => ({
        session: {
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {}),
          state: { messages: [] },
          dispose: vi.fn(async () => {}),
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
