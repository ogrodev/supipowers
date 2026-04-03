import { describe, expect, it, mock, test } from "bun:test";
import { routeManagerAction, executeManagerAction } from "../../src/mcp/manager-tool.js";

describe("routeManagerAction", () => {
  it("requires name for add action", () => {
    const result = routeManagerAction({ action: "add" });
    expect(result.error).toContain("name");
  });

  it("requires url for add action", () => {
    const result = routeManagerAction({ action: "add", name: "figma" });
    expect(result.error).toContain("url");
  });

  it("returns valid route for add with name and url", () => {
    const result = routeManagerAction({ action: "add", name: "figma", url: "https://mcp.figma.com" });
    expect(result.error).toBeUndefined();
    expect(result.action).toBe("add");
  });

  it("requires name for remove", () => {
    const result = routeManagerAction({ action: "remove" });
    expect(result.error).toContain("name");
  });

  it("routes list without name", () => {
    const result = routeManagerAction({ action: "list" });
    expect(result.error).toBeUndefined();
    expect(result.action).toBe("list");
  });

  it("routes refresh without name (refresh all)", () => {
    const result = routeManagerAction({ action: "refresh" });
    expect(result.error).toBeUndefined();
    expect(result.action).toBe("refresh");
  });

  it("routes set-activation with required fields", () => {
    const result = routeManagerAction({ action: "set-activation", name: "figma", activation: "always" });
    expect(result.error).toBeUndefined();
  });

  it("rejects set-activation without activation value", () => {
    const result = routeManagerAction({ action: "set-activation", name: "figma" });
    expect(result.error).toContain("activation");
  });
});

describe("executeManagerAction", () => {
  const baseDeps = {
    addServer: mock(),
    removeServer: mock(),
    updateServer: mock(),
  };

  it("returns error when route validation fails", async () => {
    const ctx = { hasUI: false, ui: {}, cwd: "/tmp" };
    const result = await executeManagerAction({ action: "add" }, ctx, baseDeps);
    expect(result.error).toBe(true);
    expect(result.content[0].text).toContain("name");
  });

  it("shows confirmation and proceeds on accept", async () => {
    const ctx = {
      hasUI: true,
      ui: { confirm: mock(async () => true) },
      cwd: "/tmp",
    };
    const result = await executeManagerAction(
      { action: "add", name: "figma", url: "https://mcp.figma.com" },
      ctx,
      baseDeps,
    );
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Add MCP Server",
      'Add "figma" from https://mcp.figma.com?',
    );
    expect(result.content[0].text).toContain("add initiated");
    expect(result.error).toBeUndefined();
  });

  it("returns cancel message when user declines confirmation", async () => {
    const ctx = {
      hasUI: true,
      ui: { confirm: mock(async () => false) },
      cwd: "/tmp",
    };
    const result = await executeManagerAction(
      { action: "add", name: "figma", url: "https://mcp.figma.com" },
      ctx,
      baseDeps,
    );
    expect(result.content[0].text).toContain("cancelled");
  });

  it("skips confirmation when no UI", async () => {
    const ctx = { hasUI: false, ui: {}, cwd: "/tmp" };
    const result = await executeManagerAction(
      { action: "add", name: "figma", url: "https://mcp.figma.com" },
      ctx,
      baseDeps,
    );
    expect(result.content[0].text).toContain("add initiated");
  });

  it("handles default action", async () => {
    const ctx = { hasUI: false, ui: {}, cwd: "/tmp" };
    const result = await executeManagerAction(
      { action: "list" },
      ctx,
      baseDeps,
    );
    expect(result.content[0].text).toContain("list");
    expect(result.content[0].text).toContain("executed");
  });
});
