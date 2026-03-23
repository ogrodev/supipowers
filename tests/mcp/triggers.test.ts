import { describe, it, expect } from "vitest";
import { generateTriggers } from "../../src/mcp/triggers.js";
import type { McpTool } from "../../src/mcp/types.js";

describe("generateTriggers", () => {
  it("extracts keywords from tool names", () => {
    const tools: McpTool[] = [
      { name: "get_design_context", description: "Get design context from Figma" },
      { name: "get_screenshot", description: "Capture a screenshot of a node" },
    ];
    const triggers = generateTriggers("figma", tools);
    expect(triggers).toContain("figma");
    expect(triggers).toContain("design");
    expect(triggers).toContain("screenshot");
  });

  it("excludes generic verbs", () => {
    const tools: McpTool[] = [
      { name: "get_items", description: "Get all items from the list" },
      { name: "create_item", description: "Create a new item" },
    ];
    const triggers = generateTriggers("myserver", tools);
    expect(triggers).not.toContain("get");
    expect(triggers).not.toContain("create");
    expect(triggers).toContain("items");
  });

  it("always includes server name", () => {
    const triggers = generateTriggers("linear", []);
    expect(triggers).toContain("linear");
  });

  it("caps at 10 triggers", () => {
    const tools: McpTool[] = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_keyword${i}_unique${i}`,
      description: `Description with unique word uniquedesc${i}`,
    }));
    const triggers = generateTriggers("server", tools);
    expect(triggers.length).toBeLessThanOrEqual(10);
  });

  it("handles camelCase tool names", () => {
    const tools: McpTool[] = [
      { name: "getDesignContext", description: "Fetch design context" },
    ];
    const triggers = generateTriggers("test", tools);
    expect(triggers).toContain("design");
    expect(triggers).toContain("context");
  });

  it("deduplicates triggers", () => {
    const tools: McpTool[] = [
      { name: "get_design", description: "Get the design" },
      { name: "update_design", description: "Update the design" },
    ];
    const triggers = generateTriggers("test", tools);
    const designCount = triggers.filter((t) => t === "design").length;
    expect(designCount).toBe(1);
  });
});
