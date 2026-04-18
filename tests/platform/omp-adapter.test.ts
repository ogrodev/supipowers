import { describe, expect, it, mock, test } from "bun:test";
import * as path from "node:path";
import { createOmpAdapter } from "../../src/platform/omp.js";

function createMockOmpApi() {
  return {
    pi: { createAgentSession: mock(async () => ({
      session: {
        subscribe: mock(() => () => {}),
        prompt: mock(async () => {}),
        state: { messages: [] },
        dispose: mock(async () => {}),
      },
    })) },
    registerCommand: mock(),
    getCommands: mock(() => []),
    getActiveTools: mock(() => []),
    exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: mock(),
    registerMessageRenderer: mock(),
    on: mock(),
  };
}

describe("createOmpAdapter", () => {
  it("returns platform with name 'omp'", () => {
    const adapter = createOmpAdapter(createMockOmpApi());
    expect(adapter.name).toBe("omp");
  });

  it("has OMP paths using .omp directory", () => {
    const adapter = createOmpAdapter(createMockOmpApi());
    expect(adapter.paths.dotDir).toBe(".omp");
    expect(adapter.paths.project("/proj", "plans")).toBe(
      path.join("/proj", ".omp", "supipowers", "plans"),
    );
  });

  it("normalizes input event: { action: 'handled' } → { handled: true }", () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);
    adapter.on("input", () => ({ action: "handled" }));
    expect(raw.on).toHaveBeenCalledWith("input", expect.any(Function));
    const ompHandler = raw.on.mock.calls[0][1];
    const result = ompHandler({ text: "/supi" }, {});
    expect(result).toEqual({ handled: true });
  });

  it("maps session_compact to session.compacting on OMP", () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);
    const handler = mock();
    adapter.on("session_compact", handler);
    expect(raw.on).toHaveBeenCalledWith("session.compacting", handler);
  });

  it("passes non-translated events through", () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);
    const handler = mock();
    adapter.on("tool_call", handler);
    expect(raw.on).toHaveBeenCalledWith("tool_call", handler);
  });

  it("creates agent sessions via pi.pi.createAgentSession", async () => {
    const raw = createMockOmpApi();
    const adapter = createOmpAdapter(raw);
    const session = await adapter.createAgentSession({ cwd: "/tmp" });
    expect(raw.pi.createAgentSession).toHaveBeenCalled();
    expect(session.subscribe).toBeDefined();
    expect(session.prompt).toBeDefined();
    expect(session.dispose).toBeDefined();
  });
});
