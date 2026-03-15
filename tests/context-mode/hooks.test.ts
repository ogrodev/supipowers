// tests/context-mode/hooks.test.ts
import { registerContextModeHooks, _resetCache } from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { SupipowersConfig } from "../../src/types.js";

function createMockPi() {
  const handlers = new Map<string, Function>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    getActiveTools: vi.fn(() => [] as string[]),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    _handlers: handlers,
  } as any;
}

describe("registerContextModeHooks", () => {
  beforeEach(() => {
    _resetCache();
  });

  test("registers hooks when enabled", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  test("does not register hooks when disabled", () => {
    const pi = createMockPi();
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
    };
    registerContextModeHooks(pi, config);
    expect(pi.on).not.toHaveBeenCalled();
  });

  test("tool_result handler compresses large bash output", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_result");
    expect(handler).toBeDefined();

    const bigOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(20)}`).join("\n");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls" },
      content: [{ type: "text", text: bigOutput }],
      isError: false,
      details: { exitCode: 0 },
    };

    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.content[0].text).toContain("[...compressed:");
  });

  test("tool_result handler passes through small output", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "hi" }],
      isError: false,
      details: { exitCode: 0 },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_call handler blocks curl when context-mode detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("ctx_fetch_and_index");
  });

  test("tool_call handler passes through curl when context-mode not detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "read"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_call handler passes through non-HTTP bash commands", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls -la" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("before_agent_start handler concatenates routing when context-mode detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "ctx_execute", "ctx_search"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };
    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain("You are an assistant.");
    expect(result.systemPrompt).toContain("Context Mode");
  });

  test("before_agent_start handler is no-op when context-mode not detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "read"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };
    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_result handler extracts events without throwing (fire-and-forget)", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "test-id",
      input: { path: "/src/test.ts" },
      content: [{ type: "text", text: "content" }],
      isError: false,
      details: undefined,
    };

    // Handler should not throw even without event store initialized
    expect(() => handler(event, {})).not.toThrow();
  });

  test("registers compaction hooks when compaction enabled", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);
    const events = pi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_before_compact");
    expect(events).toContain("session.compacting");
  });

  test("does not register compaction hooks when disabled", () => {
    const pi = createMockPi();
    const config = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, compaction: false },
    };
    registerContextModeHooks(pi, config);
    const events = pi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).not.toContain("session_before_compact");
    expect(events).not.toContain("session.compacting");
  });
});
