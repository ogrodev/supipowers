import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import supipowers from "../../src/index.js";

function createMockPi(overrides: Record<string, unknown> = {}) {
  return {
    registerCommand: mock(),
    registerTool: mock(),
    registerMessageRenderer: mock(),
    on: mock(),
    sendMessage: mock(),
    getActiveTools: mock(() => []),
    getCommands: mock(() => []),
    exec: mock(),
    createAgentSession: mock(),
    ...overrides,
  } as any;
}

let restoreCwd: string | null = null;

afterEach(() => {
  if (restoreCwd) {
    process.chdir(restoreCwd);
    restoreCwd = null;
  }
});

describe("extension entry point", () => {
  test("registers all commands without errors", () => {
    const registeredCommands: string[] = [];
    const mockPi = createMockPi({
      registerCommand: mock((name: string) => {
        registeredCommands.push(name);
      }),
    });

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
    expect(registeredCommands).toContain("supi:harness");
  });

  test("registers context-mode hooks when enabled", () => {
    const mockPi = createMockPi();

    supipowers(mockPi);

    const onCalls = mockPi.on.mock.calls.map((c: any[]) => c[0]);
    expect(onCalls).toContain("tool_result");
    expect(onCalls).toContain("tool_call");
    expect(onCalls).toContain("before_agent_start");
  });

  test("registers native MemPalace tool and lifecycle hooks when enabled", () => {
    const mockPi = createMockPi();

    supipowers(mockPi);

    const tools = mockPi.registerTool.mock.calls.map((call: any[]) => call[0].name);
    expect(tools).toContain("mempalace");
    const onCalls = mockPi.on.mock.calls.map((call: any[]) => call[0]);
    expect(onCalls).toContain("before_agent_start");
    expect(onCalls).toContain("session.before_compacting");
    expect(onCalls).toContain("session_shutdown");
  });

  test("skips MemPalace registration when disabled in project config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-extension-config-"));
    restoreCwd = process.cwd();
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "fixture" }));
    fs.mkdirSync(path.join(tmpDir, ".omp", "supipowers"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".omp", "supipowers", "config.json"),
      JSON.stringify({ mempalace: { enabled: false } }),
    );
    process.chdir(tmpDir);

    const mockPi = createMockPi();
    supipowers(mockPi);

    const tools = mockPi.registerTool.mock.calls.map((call: any[]) => call[0].name);
    expect(tools).not.toContain("mempalace");
  });

  test("does not crash when registerTool is unavailable", () => {
    const mockPi = createMockPi({ registerTool: undefined });

    expect(() => supipowers(mockPi)).not.toThrow();
  });
});
