
import { lookupMcpServer, pickBestMatch } from "../../src/mcp/registry.js";
import type { RegistryServer } from "../../src/mcp/registry.js";

describe("lookupMcpServer", () => {
  it("parses registry response with remotes", async () => {
    const mockExec = async (_cmd: string, _args: string[]) => ({
      stdout: JSON.stringify({
        servers: [{
          server: {
            name: "com.figma.mcp/mcp",
            title: "Figma MCP Server",
            description: "The official Figma MCP server",
            repository: { url: "https://github.com/figma/mcp-server-guide" },
            remotes: [{
              type: "streamable-http",
              url: "https://mcp.figma.com/mcp",
              headers: [{ name: "Authorization", isRequired: true }],
            }],
          },
        }],
      }),
      stderr: "",
      code: 0,
    });

    const results = await lookupMcpServer(mockExec, "figma");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("com.figma.mcp/mcp");
    expect(results[0].url).toBe("https://mcp.figma.com/mcp");
    expect(results[0].transport).toBe("http");
    expect(results[0].authRequired).toBe(true);
    expect(results[0].repoUrl).toBe("https://github.com/figma/mcp-server-guide");
  });

  it("returns empty on curl failure", async () => {
    const mockExec = async () => ({ stdout: "", stderr: "timeout", code: 28 });
    const results = await lookupMcpServer(mockExec, "figma");
    expect(results).toEqual([]);
  });

  it("returns empty on invalid JSON", async () => {
    const mockExec = async () => ({ stdout: "not json", stderr: "", code: 0 });
    const results = await lookupMcpServer(mockExec, "figma");
    expect(results).toEqual([]);
  });

  it("filters out entries without remotes", async () => {
    const mockExec = async () => ({
      stdout: JSON.stringify({
        servers: [
          { server: { name: "stdio-only", remotes: [] } },
          { server: { name: "has-remote", remotes: [{ type: "sse", url: "https://test.com" }] } },
        ],
      }),
      stderr: "",
      code: 0,
    });

    const results = await lookupMcpServer(mockExec, "test");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("has-remote");
  });

  it("maps stdio transport correctly", async () => {
    const mockExec = async () => ({
      stdout: JSON.stringify({
        servers: [{
          server: {
            name: "local-server",
            remotes: [{ type: "stdio", url: "npx some-server" }],
          },
        }],
      }),
      stderr: "",
      code: 0,
    });

    const results = await lookupMcpServer(mockExec, "local");
    expect(results[0].transport).toBe("stdio");
  });
});

describe("pickBestMatch", () => {
  const servers: RegistryServer[] = [
    { name: "com.figma.mcp/mcp", title: "Figma MCP Server", description: "", url: "https://mcp.figma.com/mcp", transport: "http", authRequired: false },
    { name: "io.other/figma-tools", title: "Figma Community Tools", description: "", url: "https://other.com", transport: "http", authRequired: false },
    { name: "com.linear.mcp/mcp", title: "Linear", description: "", url: "https://linear.com/mcp", transport: "http", authRequired: false },
  ];

  it("prefers exact name segment match", () => {
    const match = pickBestMatch(servers, "figma");
    expect(match?.name).toBe("com.figma.mcp/mcp");
  });

  it("falls back to title match", () => {
    const tweaked = servers.map((s) => ({ ...s, name: s.name.replace("figma", "fg") }));
    const match = pickBestMatch(tweaked, "figma");
    expect(match?.title).toContain("Figma");
  });

  it("returns undefined when no match", () => {
    const match = pickBestMatch(servers, "nonexistent");
    expect(match).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    const match = pickBestMatch(servers, "FIGMA");
    expect(match?.name).toBe("com.figma.mcp/mcp");
  });
});
