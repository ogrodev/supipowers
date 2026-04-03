// tests/mcp/lifecycle.test.ts

import { initializeMcpServers, shutdownMcpServers } from "../../src/mcp/lifecycle.js";
import type { McpRegistry, ServerConfig, McpTool } from "../../src/mcp/types.js";

describe("initializeMcpServers", () => {
  const makeConfig = (overrides?: Partial<ServerConfig>): ServerConfig => ({
    url: "https://test.com",
    transport: "http",
    activation: "always",
    taggable: true,
    triggers: [],
    antiTriggers: [],
    enabled: true,
    authPending: false,
    addedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  it("connects enabled servers and returns their states", async () => {
    const tools: McpTool[] = [{ name: "test_tool", description: "A test tool" }];
    const mockClient = {
      checkInstalled: async () => ({ installed: true, version: "1.0.0" }),
      autoInstall: async () => true,
      connect: async () => ({ code: 0, output: "ok" }),
      toolsList: async () => ({ code: 0, tools }),
      close: async () => ({ code: 0, output: "ok" }),
    };

    const registry: McpRegistry = {
      schemaVersion: 1,
      servers: { figma: makeConfig() },
    };

    const states = await initializeMcpServers(registry, mockClient as any);
    expect(states.figma).toBeDefined();
    expect(states.figma.status).toBe("connected");
    expect(states.figma.catalog?.tools).toHaveLength(1);
  });

  it("skips disabled servers", async () => {
    const mockClient = {
      checkInstalled: async () => ({ installed: true }),
      connect: async () => ({ code: 0, output: "" }),
      toolsList: async () => ({ code: 0, tools: [] }),
    };

    const registry: McpRegistry = {
      schemaVersion: 1,
      servers: { disabled: makeConfig({ enabled: false }) },
    };

    const states = await initializeMcpServers(registry, mockClient as any);
    expect(states.disabled.status).toBe("disconnected");
  });

  it("marks auth-pending on exit code 4", async () => {
    const mockClient = {
      checkInstalled: async () => ({ installed: true }),
      connect: async () => ({ code: 4, output: "auth required" }),
      toolsList: async () => ({ code: 0, tools: [] }),
    };

    const registry: McpRegistry = {
      schemaVersion: 1,
      servers: { figma: makeConfig() },
    };

    const states = await initializeMcpServers(registry, mockClient as any);
    expect(states.figma.status).toBe("auth-pending");
  });

  it("marks offline on exit code 3 after retry", async () => {
    let attempts = 0;
    const mockClient = {
      checkInstalled: async () => ({ installed: true }),
      connect: async () => { attempts++; return { code: 3, output: "timeout" }; },
      toolsList: async () => ({ code: 0, tools: [] }),
    };

    const registry: McpRegistry = {
      schemaVersion: 1,
      servers: { figma: makeConfig() },
    };

    const states = await initializeMcpServers(registry, mockClient as any);
    expect(states.figma.status).toBe("offline");
    expect(attempts).toBe(2); // initial + 1 retry
  });
});

describe("shutdownMcpServers", () => {
  it("closes all sessions when closeOnExit is true", async () => {
    const closed: string[] = [];
    const mockClient = {
      close: async (name: string) => { closed.push(name); return { code: 0, output: "" }; },
    };

    await shutdownMcpServers(["figma", "linear"], mockClient as any, true);
    expect(closed).toContain("figma");
    expect(closed).toContain("linear");
  });

  it("does not close sessions when closeOnExit is false", async () => {
    const closed: string[] = [];
    const mockClient = {
      close: async (name: string) => { closed.push(name); return { code: 0, output: "" }; },
    };

    await shutdownMcpServers(["figma"], mockClient as any, false);
    expect(closed).toHaveLength(0);
  });
});
