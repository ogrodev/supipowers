import { describe, it, expect } from "vitest";
import { routeManagerAction } from "../../src/mcp/manager-tool.js";

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
