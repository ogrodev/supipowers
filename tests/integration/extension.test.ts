import { describe, expect, mock, test } from "bun:test";
import supipowers from "../../src/index.js";

describe("extension entry point", () => {
  test("registers all commands without errors", () => {
    const registeredCommands: string[] = [];
    const mockPi = {
      registerCommand: mock((name: string) => {
        registeredCommands.push(name);
      }),
      registerTool: mock(),
      registerMessageRenderer: mock(),
      on: mock(),
      sendMessage: mock(),
      getActiveTools: mock(() => []),
      getCommands: mock(() => []),
      exec: mock(),
      createAgentSession: mock(),
    } as any;

    expect(() => supipowers(mockPi)).not.toThrow();

    expect(registeredCommands).toContain("supi");
    expect(registeredCommands).toContain("supi:plan");
    expect(registeredCommands).toContain("supi:review");
    expect(registeredCommands).toContain("supi:qa");
    expect(registeredCommands).toContain("supi:release");
    expect(registeredCommands).toContain("supi:config");
    expect(registeredCommands).toContain("supi:status");
    expect(registeredCommands).toContain("supi:update");
    expect(registeredCommands).toContain("supi:context");
    expect(registeredCommands).toContain("supi:commit");
    expect(registeredCommands).toContain("supi:ui-design");
  });

  test("registers context-mode hooks when enabled", () => {
    const mockPi = {
      registerCommand: mock(),
      registerTool: mock(),
      registerMessageRenderer: mock(),
      on: mock(),
      sendMessage: mock(),
      getActiveTools: mock(() => []),
      getCommands: mock(() => []),
      exec: mock(),
      createAgentSession: mock(),
    } as any;

    supipowers(mockPi);

    // Verify context-mode hooks are registered
    const onCalls = mockPi.on.mock.calls.map((c: any[]) => c[0]);
    expect(onCalls).toContain("tool_result");
    expect(onCalls).toContain("tool_call");
    expect(onCalls).toContain("before_agent_start");
  });
});
