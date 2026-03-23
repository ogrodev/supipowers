// tests/mcp/config.test.ts
import { describe, it, expect } from "vitest";
import { isValidServerName, createEmptyRegistry } from "../../src/mcp/types.js";

describe("isValidServerName", () => {
  it("accepts valid names", () => {
    expect(isValidServerName("figma").valid).toBe(true);
    expect(isValidServerName("my-server").valid).toBe(true);
    expect(isValidServerName("s3").valid).toBe(true);
  });

  it("rejects names starting/ending with hyphen", () => {
    expect(isValidServerName("-figma").valid).toBe(false);
    expect(isValidServerName("figma-").valid).toBe(false);
  });

  it("rejects uppercase", () => {
    expect(isValidServerName("Figma").valid).toBe(false);
  });

  it("rejects reserved names", () => {
    const r = isValidServerName("path");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("reserved");
  });

  it("rejects empty and too-long names", () => {
    expect(isValidServerName("").valid).toBe(false);
    expect(isValidServerName("a".repeat(64)).valid).toBe(false);
  });

  it("accepts max-length name", () => {
    expect(isValidServerName("a".repeat(63)).valid).toBe(true);
  });
});

describe("createEmptyRegistry", () => {
  it("returns fresh registry each time", () => {
    const a = createEmptyRegistry();
    const b = createEmptyRegistry();
    expect(a.schemaVersion).toBe(1);
    expect(a.servers).toEqual({});
    expect(a).not.toBe(b); // new object each call
  });
});

import { beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadMcpRegistry, saveMcpRegistry, addServer, removeServer, updateServer } from "../../src/mcp/config.js";
import { createPaths } from "../../src/platform/types.js";
import type { ServerConfig } from "../../src/mcp/types.js";

const paths = createPaths(".pi");

describe("MCP config loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mcp-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty registry when no .mcp.json exists", () => {
    const reg = loadMcpRegistry(paths, tmpDir);
    expect(reg.schemaVersion).toBe(1);
    expect(Object.keys(reg.servers)).toHaveLength(0);
  });

  it("loads project .mcp.json", () => {
    const mcpDir = path.join(tmpDir, ".pi", "supipowers");
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, ".mcp.json"), JSON.stringify({
      schemaVersion: 1,
      servers: { figma: { url: "https://mcp.figma.com/mcp", transport: "http", enabled: true } },
    }));
    const reg = loadMcpRegistry(paths, tmpDir);
    expect(reg.servers.figma).toBeDefined();
    expect(reg.servers.figma.url).toBe("https://mcp.figma.com/mcp");
  });

  it("merges global and project (project wins)", () => {
    // Use tmpDir-based paths so we never touch real home directory
    const testPaths = {
      ...paths,
      global: (...s: string[]) => path.join(tmpDir, "global", ".pi", "supipowers", ...s),
    };

    // Create global .mcp.json
    const globalDir = testPaths.global();
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, ".mcp.json"), JSON.stringify({
      schemaVersion: 1,
      servers: {
        figma: { url: "https://global.figma.com", transport: "http", enabled: true },
        linear: { url: "https://linear.mcp.com", transport: "http", enabled: true },
      },
    }));

    // Create project .mcp.json (overrides figma)
    const projectDir = path.join(tmpDir, ".pi", "supipowers");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".mcp.json"), JSON.stringify({
      schemaVersion: 1,
      servers: { figma: { url: "https://project.figma.com", transport: "http", enabled: true } },
    }));

    const reg = loadMcpRegistry(testPaths as any, tmpDir);
    expect(reg.servers.figma.url).toBe("https://project.figma.com"); // project wins
    expect(reg.servers.linear).toBeDefined(); // global included
  });

  it("saves and reloads registry", () => {
    const reg = { schemaVersion: 1, servers: { test: { url: "https://test.com", transport: "http" as const, enabled: true } } };
    saveMcpRegistry(paths, tmpDir, reg as any);
    const loaded = loadMcpRegistry(paths, tmpDir);
    expect(loaded.servers.test.url).toBe("https://test.com");
  });

  it("addServer validates name and writes config", () => {
    const config: Partial<ServerConfig> = { url: "https://test.com", transport: "http" };
    const result = addServer(paths, tmpDir, "my-server", config);
    expect(result.ok).toBe(true);

    const reg = loadMcpRegistry(paths, tmpDir);
    expect(reg.servers["my-server"]).toBeDefined();
    expect(reg.servers["my-server"].activation).toBe("contextual"); // default
    expect(reg.servers["my-server"].taggable).toBe(true); // default
  });

  it("addServer rejects invalid names", () => {
    const result = addServer(paths, tmpDir, "PATH", { url: "https://x.com", transport: "http" });
    expect(result.ok).toBe(false);
  });

  it("removeServer deletes from registry", () => {
    addServer(paths, tmpDir, "figma", { url: "https://test.com", transport: "http" });
    removeServer(paths, tmpDir, "figma");
    const reg = loadMcpRegistry(paths, tmpDir);
    expect(reg.servers.figma).toBeUndefined();
  });
});
