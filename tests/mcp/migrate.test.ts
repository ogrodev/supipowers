// tests/mcp/migrate.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverHostMcpServers, loadMcpRegistry } from "../../src/mcp/config.js";
import type { PlatformPaths } from "../../src/platform/types.js";

/**
 * Build a PlatformPaths whose agent()/global() resolve under the given homeDir
 * instead of the real os.homedir(). This avoids the ESM limitation where
 * vi.spyOn(os, "homedir") cannot redefine a named export.
 */
function createTestPaths(homeDir: string, dotDir = ".pi"): PlatformPaths {
  return {
    dotDir,
    dotDirDisplay: dotDir,
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, dotDir, "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(homeDir, dotDir, "supipowers", ...segments),
    agent: (...segments: string[]) =>
      path.join(homeDir, dotDir, "agent", ...segments),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function writeHostConfig(dir: string, dotDir: string, servers: Record<string, unknown>): void {
  const mcpDir = path.join(dir, dotDir);
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(path.join(mcpDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

function writeSuipowersRegistry(dir: string, dotDir: string, servers: Record<string, unknown>): void {
  const regDir = path.join(dir, dotDir, "supipowers");
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, ".mcp.json"), JSON.stringify({ schemaVersion: 1, servers }));
}

// ── discoverHostMcpServers ────────────────────────────────────

describe("discoverHostMcpServers", () => {
  let tmpDir: string;
  /** A homeDir that doesn't exist, so no user/claude-code configs leak in. */
  let noHome: string;
  let paths: PlatformPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-migrate-test-"));
    noHome = path.join(tmpDir, "__no_home__");
    paths = createTestPaths(noHome);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no host config files exist", () => {
    const result = discoverHostMcpServers(paths, tmpDir, noHome);
    expect(result).toEqual([]);
  });

  it("discovers project-level HTTP servers", () => {
    writeHostConfig(tmpDir, ".pi", {
      figma: { type: "http", url: "https://mcp.figma.com" },
    });

    const result = discoverHostMcpServers(paths, tmpDir, noHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "figma",
      scope: "project",
      transport: "http",
      url: "https://mcp.figma.com",
    });
  });

  it("discovers project-level stdio servers", () => {
    writeHostConfig(tmpDir, ".pi", {
      "my-tool": { command: "my-tool", args: ["--flag"] },
    });

    const result = discoverHostMcpServers(paths, tmpDir, noHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "my-tool",
      scope: "project",
      transport: "stdio",
      command: "my-tool",
      args: ["--flag"],
    });
  });

  it("treats missing type as stdio", () => {
    writeHostConfig(tmpDir, ".pi", {
      tool: { command: "mytool" },
    });

    const [server] = discoverHostMcpServers(paths, tmpDir, noHome);
    expect(server.transport).toBe("stdio");
  });

  it("discovers SSE servers and marks transport as sse", () => {
    writeHostConfig(tmpDir, ".pi", {
      legacy: { type: "sse", url: "https://example.com/sse" },
    });

    const [server] = discoverHostMcpServers(paths, tmpDir, noHome);
    expect(server.transport).toBe("sse");
    expect(server.url).toBe("https://example.com/sse");
  });

  it("skips explicitly disabled servers (enabled: false)", () => {
    writeHostConfig(tmpDir, ".pi", {
      active: { type: "http", url: "https://active.com" },
      disabled: { type: "http", url: "https://disabled.com", enabled: false },
    });

    const result = discoverHostMcpServers(paths, tmpDir, noHome);
    expect(result.map((s) => s.name)).toEqual(["active"]);
  });

  it("marks hasAuth when auth or oauth field is present", () => {
    writeHostConfig(tmpDir, ".pi", {
      withAuth: { type: "http", url: "https://mcp.example.com", auth: { type: "oauth" } },
      withOAuth: { type: "http", url: "https://other.com", oauth: { clientId: "x" } },
      noAuth: { type: "http", url: "https://open.com" },
    });

    const result = discoverHostMcpServers(paths, tmpDir, noHome);
    const byName = Object.fromEntries(result.map((s) => [s.name, s]));

    expect(byName["withAuth"]?.hasAuth).toBe(true);
    expect(byName["withOAuth"]?.hasAuth).toBe(true);
    expect(byName["noAuth"]?.hasAuth).toBe(false);
  });

  it("discovers user-level servers via homeDir injection", () => {
    // Create a fake homedir with agent-level host config (~/.pi/agent/mcp.json)
    const fakeHome = path.join(tmpDir, "fakehome");
    fs.mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".pi", "agent", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { type: "http", url: "https://mcp.github.com" },
        },
      }),
    );

    const homePaths = createTestPaths(fakeHome);
    const result = discoverHostMcpServers(homePaths, tmpDir, fakeHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "github",
      scope: "user",
      transport: "http",
      url: "https://mcp.github.com",
    });
  });

  it("merges user, project, and claude-code scope servers", () => {
    // Fake homedir with agent-level config
    const fakeHome = path.join(tmpDir, "fakehome");
    fs.mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { github: { type: "http", url: "https://mcp.github.com" } } }),
    );

    // Claude Code config at ~/.claude.json
    fs.writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ mcpServers: { pencil: { type: "stdio", command: "/path/to/pencil" } } }),
    );

    // Project-level config
    writeHostConfig(tmpDir, ".pi", {
      figma: { type: "http", url: "https://mcp.figma.com" },
    });

    const homePaths = createTestPaths(fakeHome);
    const result = discoverHostMcpServers(homePaths, tmpDir, fakeHome);
    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["figma", "github", "pencil"]);
    expect(result.find((s) => s.name === "github")?.scope).toBe("user");
    expect(result.find((s) => s.name === "figma")?.scope).toBe("project");
    expect(result.find((s) => s.name === "pencil")?.scope).toBe("claude-code");
  });

  it("discovers Claude Code servers from ~/.claude.json", () => {
    const fakeHome = path.join(tmpDir, "fakehome");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          pencil: { type: "stdio", command: "/app/pencil", args: ["--app", "desktop"], env: {} },
        },
      }),
    );

    const homePaths = createTestPaths(fakeHome);
    const result = discoverHostMcpServers(homePaths, tmpDir, fakeHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "pencil",
      scope: "claude-code",
      transport: "stdio",
      command: "/app/pencil",
      args: ["--app", "desktop"],
    });
  });
});

// ── Diff logic (filter already-managed) ──────────────────────

describe("diff against supi registry", () => {
  let tmpDir: string;
  let noHome: string;
  let paths: PlatformPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-migrate-diff-"));
    noHome = path.join(tmpDir, "__no_home__");
    paths = createTestPaths(noHome);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes servers already present in supipowers registry", () => {
    writeHostConfig(tmpDir, ".pi", {
      figma: { type: "http", url: "https://mcp.figma.com" },
      github: { type: "http", url: "https://mcp.github.com" },
      linear: { type: "http", url: "https://linear.mcp.com" },
    });

    // Supipowers already manages figma
    writeSuipowersRegistry(tmpDir, ".pi", {
      figma: { url: "https://mcp.figma.com", transport: "http", enabled: true },
    });

    const registry = loadMcpRegistry(paths, tmpDir);
    const managedNames = new Set(Object.keys(registry.servers));

    const allHost = discoverHostMcpServers(paths, tmpDir, noHome);
    const candidates = allHost.filter((s) => !managedNames.has(s.name));

    const names = candidates.map((s) => s.name).sort();
    expect(names).toEqual(["github", "linear"]);
    expect(candidates.find((s) => s.name === "figma")).toBeUndefined();
  });

  it("returns all host servers when supi registry is empty", () => {
    writeHostConfig(tmpDir, ".pi", {
      server1: { type: "http", url: "https://s1.com" },
      server2: { command: "s2" },
    });

    const registry = loadMcpRegistry(paths, tmpDir);
    const managedNames = new Set(Object.keys(registry.servers));

    const allHost = discoverHostMcpServers(paths, tmpDir, noHome);
    const candidates = allHost.filter((s) => !managedNames.has(s.name));

    expect(candidates).toHaveLength(2);
  });
});

// ── Transport mapping (host → supi) ──────────────────────────

describe("transport mapping", () => {
  it("maps http type correctly", () => {
    // The mapping used in handleMcpMigrate:
    //   sse → http (treated as HTTP URL-based)
    //   stdio → stdio
    //   http → http

    function mapTransport(t: "http" | "stdio" | "sse"): "http" | "stdio" {
      return t === "stdio" ? "stdio" : "http";
    }

    expect(mapTransport("http")).toBe("http");
    expect(mapTransport("stdio")).toBe("stdio");
    expect(mapTransport("sse")).toBe("http"); // SSE deprecated → treat as http
  });
});
