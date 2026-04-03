// tests/mcp/mcpc.test.ts

import { McpcClient } from "../../src/mcp/mcpc.js";
import { MCPC_EXIT } from "../../src/mcp/types.js";

describe("McpcClient", () => {
  const mockExec = (responses: Record<string, { stdout: string; stderr: string; code: number }>) => {
    return async (cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(" ");
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern)) return response;
      }
      return { stdout: "", stderr: "unknown command", code: 1 };
    };
  };

  it("checkInstalled returns true when mcpc is in PATH", async () => {
    const exec = mockExec({ "mcpc --version": { stdout: "mcpc 1.2.3\n", stderr: "", code: 0 } });
    const client = new McpcClient(exec);
    const result = await client.checkInstalled();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.2.3");
  });

  it("checkInstalled returns false when not found", async () => {
    const exec = mockExec({ "mcpc --version": { stdout: "", stderr: "", code: 127 } });
    const client = new McpcClient(exec);
    const result = await client.checkInstalled();
    expect(result.installed).toBe(false);
  });

  it("connect creates a named session", async () => {
    const exec = mockExec({
      "connect @supi-figma": { stdout: "Connected\n", stderr: "", code: 0 },
    });
    const client = new McpcClient(exec);
    const result = await client.connect("https://mcp.figma.com/mcp", "figma");
    expect(result.code).toBe(MCPC_EXIT.SUCCESS);
  });

  it("connect returns auth error code", async () => {
    const exec = mockExec({
      "connect @supi-figma": { stdout: "", stderr: "Auth required", code: 4 },
    });
    const client = new McpcClient(exec);
    const result = await client.connect("https://mcp.figma.com/mcp", "figma");
    expect(result.code).toBe(MCPC_EXIT.AUTH_ERROR);
  });

  it("toolsList returns parsed tools", async () => {
    const tools = [
      { name: "get_design", description: "Get a design", inputSchema: { type: "object" } },
      { name: "get_screenshot", description: "Get a screenshot", inputSchema: { type: "object" } },
    ];
    const exec = mockExec({
      "tools-list": { stdout: JSON.stringify(tools), stderr: "", code: 0 },
    });
    const client = new McpcClient(exec);
    const result = await client.toolsList("figma");
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("get_design");
  });

  it("toolsCall executes and returns result", async () => {
    const response = { content: [{ type: "text", text: "result data" }] };
    const exec = mockExec({
      "tools-call": { stdout: JSON.stringify(response), stderr: "", code: 0 },
    });
    const client = new McpcClient(exec);
    const result = await client.toolsCall("figma", "get_design", { fileKey: "abc" });
    expect(result.code).toBe(0);
    expect(result.data).toEqual(response);
  });

  it("serializeArgs converts object to mcpc key:=value format", () => {
    const client = new McpcClient(async () => ({ stdout: "", stderr: "", code: 0 }));
    const args = client.serializeArgs({ query: "hello world", limit: 10, enabled: true });
    expect(args).toContain('query:="hello world"');
    expect(args).toContain("limit:=10");
    expect(args).toContain("enabled:=true");
  });

  it("close terminates a session", async () => {
    const exec = mockExec({
      "@supi-figma close": { stdout: "Closed\n", stderr: "", code: 0 },
    });
    const client = new McpcClient(exec);
    const result = await client.close("figma");
    expect(result.code).toBe(0);
  });

  it("login delegates to mcpc login", async () => {
    const exec = mockExec({
      "login": { stdout: "Logged in\n", stderr: "", code: 0 },
    });
    const client = new McpcClient(exec);
    const result = await client.login("https://mcp.figma.com/mcp");
    expect(result.code).toBe(0);
  });
});
