// tests/mcp/gateway.test.ts
import { describe, it, expect } from "vitest";
import { buildGatewayToolDef, buildPromptSnippet, buildPromptGuidelines, executeGatewayCall } from "../../src/mcp/gateway.js";
import type { ServerConfig, McpTool } from "../../src/mcp/types.js";

describe("buildPromptSnippet", () => {
  it("summarizes server with tool count", () => {
    const tools: McpTool[] = [
      { name: "get_design", description: "Get design" },
      { name: "get_screenshot", description: "Get screenshot" },
    ];
    const snippet = buildPromptSnippet("figma", tools);
    expect(snippet).toContain("mcpc_figma");
    expect(snippet).toContain("2 tools");
    expect(snippet).toContain("get_design");
  });

  it("truncates to 10 tools for large catalogs", () => {
    const tools = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}`, description: `desc ${i}` }));
    const snippet = buildPromptSnippet("apify", tools);
    expect(snippet).toContain("50 tools");
    expect(snippet).toContain("see README");
  });
});

describe("buildPromptGuidelines", () => {
  it("generates guidelines from triggers and antiTriggers", () => {
    const config: Partial<ServerConfig> = {
      triggers: ["design", "figma"],
      antiTriggers: ["screenshot capture"],
    };
    const guidelines = buildPromptGuidelines(config as ServerConfig);
    expect(guidelines.some((g) => g.includes("design"))).toBe(true);
    expect(guidelines.some((g) => g.includes("NOT"))).toBe(true);
  });
});

describe("buildGatewayToolDef", () => {
  it("creates a tool definition with correct name and parameters", () => {
    const config: Partial<ServerConfig> = {
      url: "https://mcp.figma.com",
      transport: "http",
      triggers: ["design"],
      antiTriggers: [],
    };
    const tools: McpTool[] = [{ name: "get_design", description: "Get design" }];
    const def = buildGatewayToolDef("figma", config as ServerConfig, tools);
    expect(def.name).toBe("mcpc_figma");
    expect(def.promptSnippet).toContain("mcpc_figma");
    expect(def.parameters).toBeDefined();
  });
});

describe("executeGatewayCall", () => {
  it("returns content from successful call", async () => {
    const response = { content: [{ type: "text", text: "result" }] };
    const mockClient = {
      toolsCall: async () => ({ code: 0, data: response }),
      restart: async () => ({ code: 0, output: "" }),
      toolsList: async () => ({ code: 0, tools: [] }),
    };
    const result = await executeGatewayCall(mockClient as any, "figma", "get_design", {});
    expect(result.content[0].text).toBe("result");
  });

  it("retries on session crash (exit code 3)", async () => {
    let callCount = 0;
    const response = { content: [{ type: "text", text: "ok" }] };
    const mockClient = {
      toolsCall: async () => {
        callCount++;
        if (callCount === 1) return { code: 3, error: "crashed" };
        return { code: 0, data: response };
      },
      restart: async () => ({ code: 0, output: "restarted" }),
      toolsList: async () => ({ code: 0, tools: [] }),
    };
    const result = await executeGatewayCall(mockClient as any, "figma", "get_design", {});
    expect(result.content[0].text).toBe("ok");
    expect(callCount).toBe(2);
  });

  it("throws after failed restart on crash", async () => {
    const mockClient = {
      toolsCall: async () => ({ code: 3, error: "crashed" }),
      restart: async () => ({ code: 3, output: "failed" }),
    };
    await expect(executeGatewayCall(mockClient as any, "figma", "get_design", {}))
      .rejects.toThrow();
  });

  it("triggers refresh hint on exit code 2 (stale tool)", async () => {
    const mockClient = {
      toolsCall: async () => ({ code: 2, error: "unknown tool" }),
      restart: async () => ({ code: 0, output: "" }),
      toolsList: async () => ({ code: 0, tools: [{ name: "new_tool", description: "New" }] }),
    };
    await expect(executeGatewayCall(mockClient as any, "figma", "get_design", {}))
      .rejects.toThrow(/refreshed/i);
  });
});
