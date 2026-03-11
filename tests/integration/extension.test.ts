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
});
