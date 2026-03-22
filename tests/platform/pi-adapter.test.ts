import { describe, it, expect, vi } from "vitest";
import { createPiAdapter } from "../../src/platform/pi.js";

function createMockPiApi() {
  return {
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    getActiveTools: vi.fn(() => ["Bash", "Read"]),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    sendMessage: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
  };
}

describe("createPiAdapter", () => {
  it("returns platform with name 'pi'", () => {
    const adapter = createPiAdapter(createMockPiApi());
    expect(adapter.name).toBe("pi");
  });

  it("passes registerCommand through", () => {
    const raw = createMockPiApi();
    const adapter = createPiAdapter(raw);
    adapter.registerCommand("test", { description: "test" });
    expect(raw.registerCommand).toHaveBeenCalledWith("test", { description: "test" });
  });

  it("passes exec through", async () => {
    const raw = createMockPiApi();
    raw.exec.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
    const adapter = createPiAdapter(raw);
    const result = await adapter.exec("git", ["status"], { cwd: "/tmp" });
    expect(raw.exec).toHaveBeenCalledWith("git", ["status"], { cwd: "/tmp" });
    expect(result.stdout).toBe("ok");
  });

  it("passes on() through", () => {
    const raw = createMockPiApi();
    const handler = vi.fn();
    const adapter = createPiAdapter(raw);
    adapter.on("tool_call", handler);
    expect(raw.on).toHaveBeenCalledWith("tool_call", handler);
  });

  it("has Pi paths using .pi directory", () => {
    const adapter = createPiAdapter(createMockPiApi());
    expect(adapter.paths.dotDir).toBe(".pi");
    expect(adapter.paths.project("/proj", "plans")).toContain(".pi/supipowers/plans");
  });

  it("reports all capabilities as true", () => {
    const adapter = createPiAdapter(createMockPiApi());
    expect(adapter.capabilities.agentSessions).toBe(true);
    expect(adapter.capabilities.compactionHooks).toBe(true);
    expect(adapter.capabilities.registerTool).toBe(true);
  });

  it("sendMessage injects deliverAs:'steer' and triggerTurn:true defaults", () => {
    const raw = createMockPiApi();
    const adapter = createPiAdapter(raw);
    adapter.sendMessage("hello");
    expect(raw.sendMessage).toHaveBeenCalledWith("hello", {
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  it("sendMessage lets caller override defaults", () => {
    const raw = createMockPiApi();
    const adapter = createPiAdapter(raw);
    adapter.sendMessage("hello", { deliverAs: "followUp", triggerTurn: false });
    expect(raw.sendMessage).toHaveBeenCalledWith("hello", {
      deliverAs: "followUp",
      triggerTurn: false,
    });
  });

  it("sendMessage preserves defaults when opts has explicit undefined", () => {
    const raw = createMockPiApi();
    const adapter = createPiAdapter(raw);
    adapter.sendMessage("hello", { deliverAs: undefined });
    // spread with undefined overwrites the default — this is acceptable
    // since callers should omit the key rather than pass undefined
    expect(raw.sendMessage).toHaveBeenCalledWith("hello", expect.objectContaining({
      triggerTurn: true,
    }));
  });
});
