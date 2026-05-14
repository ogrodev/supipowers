import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import supipowers from "../../src/index.js";
import { snapshotMempalaceInstall } from "../../src/mempalace/installer-helper.js";
import { createPaths } from "../../src/platform/types.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

function createMockPi(overrides: Record<string, unknown> = {}) {
  return {
    registerCommand: mock(),
    registerTool: mock(),
    registerMessageRenderer: mock(),
    on: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
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
    expect(registeredCommands).toContain("runbook");
  });


  test("intercepts /runbook without sending an LLM prompt", () => {
    const notify = mock();
    const mockPi = createMockPi({
      getCommands: mock(() => [{ name: "runbook", description: "Show runbook" }]),
    });

    supipowers(mockPi);

    const inputCall = mockPi.on.mock.calls.find((call: any[]) => call[0] === "input");
    expect(inputCall).toBeTruthy();
    const result = inputCall[1](
      { text: "/runbook commands" },
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          notify,
          select: mock(),
          input: mock(),
        },
      },
    );

    expect(result).toEqual({ handled: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("Registered slash commands: 1");
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
  });
  test("registers context-mode hooks when enabled", () => {
    const mockPi = createMockPi();

    supipowers(mockPi);

    const onCalls = mockPi.on.mock.calls.map((c: any[]) => c[0]);
    expect(onCalls).toContain("tool_result");
    expect(onCalls).toContain("tool_call");
    expect(onCalls).toContain("before_agent_start");
  });

  // The registration test depends on the managed MemPalace runtime being
  // present on disk: with the readiness gate, the tool only registers when
  // uv + the managed venv + the Python bridge are all installed. CI nodes
  // without `/supi:memory setup` run can't satisfy this; we skip rather
  // than failing on environment state. The gate itself is unit-tested in
  // tests/mempalace/tool.test.ts.
  let mempalaceReady = false;
  beforeAll(() => {
    mempalaceReady = snapshotMempalaceInstall(createPaths(".omp"), process.cwd(), DEFAULT_CONFIG).ready;
  });

  test("registers native MemPalace tool and lifecycle hooks when enabled", () => {
    if (!mempalaceReady) {
      // eslint-disable-next-line no-console -- diagnostic for env-skipped test
      console.warn("[skip] mempalace runtime not installed; run /supi:memory setup to enable this assertion");
      return;
    }
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
