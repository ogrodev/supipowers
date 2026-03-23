import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { generateReadme, generateSkill, updateAgentsMd } from "../../src/mcp/docs.js";
import type { McpTool, ServerConfig } from "../../src/mcp/types.js";

describe("generateReadme", () => {
  it("includes server name, URL, and tool list", () => {
    const tools: McpTool[] = [
      { name: "get_design", description: "Get design context", inputSchema: { type: "object", properties: { fileKey: { type: "string" } } } },
    ];
    const config: Partial<ServerConfig> = { url: "https://mcp.figma.com", transport: "http" };
    const readme = generateReadme("figma", config as ServerConfig, tools);
    expect(readme).toContain("# figma");
    expect(readme).toContain("https://mcp.figma.com");
    expect(readme).toContain("get_design");
    expect(readme).toContain("mcpc --json @supi-figma tools-call");
  });
});

describe("generateSkill", () => {
  it("includes base patterns and all server sections", () => {
    const servers = {
      figma: { tools: [{ name: "get_design", description: "Get design" }] },
      linear: { tools: [{ name: "create_issue", description: "Create issue" }] },
    };
    const skill = generateSkill(servers);
    expect(skill).toContain("name: supi:mcpc");
    expect(skill).toContain("$figma");
    expect(skill).toContain("$linear");
    expect(skill).toContain("figma (@supi-figma)");
    expect(skill).toContain("linear (@supi-linear)");
  });
});

describe("updateAgentsMd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agents-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates AGENTS.md if it doesn't exist", () => {
    const servers = { figma: { description: "Figma design tools" } };
    updateAgentsMd(tmpDir, servers);
    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("supipowers:mcpc:start");
    expect(content).toContain("$figma");
    expect(content).toContain("supipowers:mcpc:end");
  });

  it("updates existing managed section without touching user content", () => {
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# My Project\n\nUser content here.\n\n<!-- supipowers:mcpc:start -->\nold content\n<!-- supipowers:mcpc:end -->\n\nMore user content.\n");
    updateAgentsMd(tmpDir, { linear: { description: "Linear PM" } });
    const content = fs.readFileSync(agentsPath, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("User content here.");
    expect(content).toContain("More user content.");
    expect(content).toContain("$linear");
    expect(content).not.toContain("old content");
  });

  it("appends managed section to existing AGENTS.md without markers", () => {
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# My Project\n\nExisting content.\n");
    updateAgentsMd(tmpDir, { figma: { description: "Figma" } });
    const content = fs.readFileSync(agentsPath, "utf-8");
    expect(content).toContain("Existing content.");
    expect(content).toContain("supipowers:mcpc:start");
    expect(content).toContain("$figma");
  });

  it("removes managed section when no servers", () => {
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# My Project\n\n<!-- supipowers:mcpc:start -->\nold\n<!-- supipowers:mcpc:end -->\n");
    updateAgentsMd(tmpDir, {});
    const content = fs.readFileSync(agentsPath, "utf-8");
    expect(content).not.toContain("supipowers:mcpc:start");
  });
});
