import { describe, it, expect } from "vitest";
import { parseTags, shouldActivate, computeActiveServers } from "../../src/mcp/activation.js";
import type { ServerConfig } from "../../src/mcp/types.js";

describe("parseTags", () => {
  it("extracts $tagged server names from text", () => {
    const tags = parseTags("Check $linear about task SUPI-13", new Set(["linear", "figma"]));
    expect(tags).toEqual(["linear"]);
  });

  it("is case-insensitive", () => {
    const tags = parseTags("Use $Figma to get design", new Set(["figma"]));
    expect(tags).toEqual(["figma"]);
  });

  it("ignores unregistered $tags", () => {
    const tags = parseTags("Set $PATH to /usr/bin", new Set(["figma"]));
    expect(tags).toEqual([]);
  });

  it("extracts multiple tags", () => {
    const tags = parseTags("Compare $figma design with $linear issue", new Set(["figma", "linear"]));
    expect(tags).toContain("figma");
    expect(tags).toContain("linear");
  });

  it("respects word boundaries", () => {
    const tags = parseTags("$figma-plugin is not $figma", new Set(["figma", "figma-plugin"]));
    expect(tags).toContain("figma-plugin");
    expect(tags).toContain("figma");
  });

  it("returns empty for no matches", () => {
    const tags = parseTags("No tags here", new Set(["figma"]));
    expect(tags).toEqual([]);
  });
});

describe("shouldActivate", () => {
  const baseConfig: ServerConfig = {
    transport: "http",
    activation: "contextual",
    taggable: true,
    triggers: ["design", "figma"],
    antiTriggers: ["screenshot"],
    enabled: true,
    authPending: false,
    addedAt: "2026-01-01T00:00:00Z",
  };

  it("always mode activates regardless of message", () => {
    const config = { ...baseConfig, activation: "always" as const };
    expect(shouldActivate(config, "random message", false)).toBe(true);
  });

  it("contextual mode activates on trigger match", () => {
    expect(shouldActivate(baseConfig, "implement this design from figma", false)).toBe(true);
  });

  it("contextual mode does not activate without trigger", () => {
    expect(shouldActivate(baseConfig, "fix the login bug", false)).toBe(false);
  });

  it("antiTrigger wins over trigger", () => {
    expect(shouldActivate(baseConfig, "take a screenshot of the design", false)).toBe(false);
  });

  it("disabled mode does not activate", () => {
    const config = { ...baseConfig, activation: "disabled" as const };
    expect(shouldActivate(config, "design something", false)).toBe(false);
  });

  it("$tag overrides any activation mode", () => {
    const config = { ...baseConfig, activation: "disabled" as const };
    expect(shouldActivate(config, "anything", true)).toBe(true);
  });

  it("$tag is ignored when taggable is false", () => {
    const config = { ...baseConfig, activation: "disabled" as const, taggable: false };
    expect(shouldActivate(config, "anything", true)).toBe(false); // tagged but not taggable
  });

  it("disabled server is not activated", () => {
    const config = { ...baseConfig, enabled: false };
    expect(shouldActivate(config, "design", false)).toBe(false);
  });
});

describe("computeActiveServers", () => {
  it("combines tag and contextual activation", () => {
    const servers: Record<string, ServerConfig> = {
      figma: { transport: "http", activation: "contextual", taggable: true, triggers: ["design"], antiTriggers: [], enabled: true, authPending: false, addedAt: "" },
      linear: { transport: "http", activation: "always", taggable: true, triggers: [], antiTriggers: [], enabled: true, authPending: false, addedAt: "" },
      apify: { transport: "http", activation: "disabled", taggable: true, triggers: [], antiTriggers: [], enabled: true, authPending: false, addedAt: "" },
    };
    const active = computeActiveServers(servers, "implement this design", ["apify"]);
    expect(active).toContain("figma");   // contextual trigger match
    expect(active).toContain("linear");  // always
    expect(active).toContain("apify");   // tagged
  });
});
