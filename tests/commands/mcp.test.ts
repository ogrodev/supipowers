import { describe, it, expect, vi } from "vitest";
import { parseCliArgs, handleMcpCli } from "../../src/commands/mcp.js";
import { createMockPlatform, createMockContext } from "../../src/platform/test-utils.js";

describe("parseCliArgs", () => {
  it("parses 'add figma https://mcp.figma.com'", () => {
    const parsed = parseCliArgs("add figma https://mcp.figma.com");
    expect(parsed.subcommand).toBe("add");
    expect(parsed.name).toBe("figma");
    expect(parsed.url).toBe("https://mcp.figma.com");
  });

  it("parses 'add figma' (agentic, no url)", () => {
    const parsed = parseCliArgs("add figma");
    expect(parsed.subcommand).toBe("add");
    expect(parsed.name).toBe("figma");
    expect(parsed.url).toBeUndefined();
  });

  it("parses 'add --transport stdio local-db node ./server.js'", () => {
    const parsed = parseCliArgs("add --transport stdio local-db node ./server.js");
    expect(parsed.subcommand).toBe("add");
    expect(parsed.transport).toBe("stdio");
    expect(parsed.name).toBe("local-db");
    expect(parsed.command).toBe("node");
    expect(parsed.commandArgs).toEqual(["./server.js"]);
  });

  it("parses 'enable figma'", () => {
    const parsed = parseCliArgs("enable figma");
    expect(parsed.subcommand).toBe("enable");
    expect(parsed.name).toBe("figma");
  });

  it("parses 'refresh' (all)", () => {
    const parsed = parseCliArgs("refresh");
    expect(parsed.subcommand).toBe("refresh");
    expect(parsed.name).toBeUndefined();
  });

  it("parses 'refresh figma' (one)", () => {
    const parsed = parseCliArgs("refresh figma");
    expect(parsed.subcommand).toBe("refresh");
    expect(parsed.name).toBe("figma");
  });

  it("parses 'activation figma contextual'", () => {
    const parsed = parseCliArgs("activation figma contextual");
    expect(parsed.subcommand).toBe("activation");
    expect(parsed.name).toBe("figma");
    expect(parsed.activation).toBe("contextual");
  });

  it("parses 'tag figma on'", () => {
    const parsed = parseCliArgs("tag figma on");
    expect(parsed.subcommand).toBe("tag");
    expect(parsed.name).toBe("figma");
    expect(parsed.taggable).toBe(true);
  });

  it("parses 'list --json'", () => {
    const parsed = parseCliArgs("list --json");
    expect(parsed.subcommand).toBe("list");
    expect(parsed.json).toBe(true);
  });

  it("returns empty subcommand for no args", () => {
    const parsed = parseCliArgs("");
    expect(parsed.subcommand).toBeUndefined();
  });
});

describe("handleMcpCli — agentic add flow", () => {
  it("triggers agentic search when add has name but no url or command", async () => {
    const platform = createMockPlatform();
    const ctx = createMockContext();

    await handleMcpCli(platform, ctx, { subcommand: "add", name: "figma" });

    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-mcp-search",
        display: true,
      }),
      expect.objectContaining({
        deliverAs: "steer",
        triggerTurn: true,
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Searching for "figma" MCP server...',
      "info",
    );
  });

  it("does not trigger agentic search when url is provided", async () => {
    const platform = createMockPlatform();
    const ctx = createMockContext();

    // This will fail at acquireLock or addServer, but sendMessage should NOT be called
    try {
      await handleMcpCli(platform, ctx, {
        subcommand: "add",
        name: "figma",
        url: "https://mcp.figma.com",
      });
    } catch {
      // Expected — downstream deps not mocked
    }

    expect(platform.sendMessage).not.toHaveBeenCalled();
  });

  it("does not trigger agentic search when command is provided (stdio)", async () => {
    const platform = createMockPlatform();
    const ctx = createMockContext();

    try {
      await handleMcpCli(platform, ctx, {
        subcommand: "add",
        name: "local-db",
        command: "node",
        commandArgs: ["./server.js"],
        transport: "stdio",
      });
    } catch {
      // Expected — downstream deps not mocked
    }

    expect(platform.sendMessage).not.toHaveBeenCalled();
  });
});
