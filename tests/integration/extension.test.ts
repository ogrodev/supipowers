import { describe, test, expect, vi } from "vitest";
import supipowers from "../../src/index.js";

describe("extension entry point", () => {
  test("registers all commands without errors", () => {
    const registeredCommands: string[] = [];
    const mockPi = {
      registerCommand: vi.fn((name: string) => {
        registeredCommands.push(name);
      }),
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn(() => []),
      exec: vi.fn(),
    } as any;

    expect(() => supipowers(mockPi)).not.toThrow();

    expect(registeredCommands).toContain("supi");
    expect(registeredCommands).toContain("supi:plan");
    expect(registeredCommands).toContain("supi:run");
    expect(registeredCommands).toContain("supi:review");
    expect(registeredCommands).toContain("supi:qa");
    expect(registeredCommands).toContain("supi:release");
    expect(registeredCommands).toContain("supi:config");
    expect(registeredCommands).toContain("supi:status");
    expect(registeredCommands).toContain("supi:update");
  });

  test("registers context-mode hooks when enabled", () => {
    const mockPi = {
      registerCommand: vi.fn(),
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn(() => []),
      exec: vi.fn(),
    } as any;

    supipowers(mockPi);

    // Verify context-mode hooks are registered
    const onCalls = mockPi.on.mock.calls.map((c: any[]) => c[0]);
    expect(onCalls).toContain("tool_result");
    expect(onCalls).toContain("tool_call");
    expect(onCalls).toContain("before_agent_start");
  });
});
