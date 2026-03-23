import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../../src/commands/mcp.js";

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
