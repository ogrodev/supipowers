import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadReviewAgents,
  loadReviewAgentsConfig,
  loadGlobalReviewAgents,
  loadMergedReviewAgents,
  writeAgentFile,
  addAgentToConfig,
  getReviewAgentsDir,
  getGlobalReviewAgentsDir,
  getGlobalReviewAgentsConfigPath,
  ensureGlobalDefaultReviewAgents,
} from "../../src/review/agent-loader.js";
import type { PlatformPaths } from "../../src/platform/types.js";

function createTestPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(rootDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

function writeAgentMarkdown(dir: string, fileName: string, name: string, description: string, focus: string | null, prompt: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const focusLine = focus ? `\nfocus: ${focus}` : "";
  const content = `---\nname: ${name}\ndescription: ${description}${focusLine}\n---\n\n${prompt}\n`;
  fs.writeFileSync(path.join(dir, fileName), content);
}

function writeConfigYaml(dir: string, agents: Array<{ name: string; enabled: boolean; data: string; model: string | null; thinkingLevel?: string | null }>): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "agents:",
    ...agents.flatMap((a) => [
      `  - name: ${a.name}`,
      `    enabled: ${a.enabled}`,
      `    data: ${a.data}`,
      `    model: ${a.model ?? "null"}`,
      ...(a.thinkingLevel !== undefined ? [`    thinkingLevel: ${a.thinkingLevel ?? "null"}`] : []),
    ]),
    "",
  ];
  fs.writeFileSync(path.join(dir, "config.yml"), lines.join("\n"));
}

describe("loadReviewAgents", () => {
  let tmpDir: string;
  let paths: PlatformPaths;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-load-agents-test-"));
    paths = createTestPaths(tmpDir);
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads default 3 agents when no config exists", async () => {
    const result = await loadReviewAgents(paths, projectDir);
    expect(result.agents.length).toBe(3);
    const names = result.agents.map((a) => a.name).sort();
    expect(names).toEqual(["correctness", "maintainability", "security"]);

    const projectAgentsDir = getReviewAgentsDir(paths, projectDir);
    expect(fs.existsSync(path.join(projectAgentsDir, "security.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectAgentsDir, "correctness.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectAgentsDir, "maintainability.md"))).toBe(false);

    const globalAgentsDir = getGlobalReviewAgentsDir(paths);
    expect(fs.existsSync(path.join(globalAgentsDir, "security.md"))).toBe(true);
    expect(fs.existsSync(path.join(globalAgentsDir, "correctness.md"))).toBe(true);
    expect(fs.existsSync(path.join(globalAgentsDir, "maintainability.md"))).toBe(true);
  });

  test("loads all 4 project agents when custom agent is added to config", async () => {
    const agentsDir = getReviewAgentsDir(paths, projectDir);

    // Write all 4 agent .md files
    writeAgentMarkdown(agentsDir, "security.md", "security", "Security reviewer", null, "Review for security.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "correctness.md", "correctness", "Correctness reviewer", null, "Review for correctness.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "maintainability.md", "maintainability", "Maintainability reviewer", null, "Review for maintainability.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "performance-auditor.md", "performance-auditor", "Performance auditor", "latency, memory", "Review for performance issues.\n\n{output_instructions}");

    // Write config with all 4 agents (matching user's exact scenario)
    writeConfigYaml(agentsDir, [
      { name: "security", enabled: true, data: "security.md", model: "openai-codex/gpt-5.4" },
      { name: "correctness", enabled: true, data: "correctness.md", model: "openai-codex/gpt-5.4" },
      { name: "maintainability", enabled: true, data: "maintainability.md", model: "openai-codex/gpt-5.4" },
      { name: "performance-auditor", enabled: true, data: "performance-auditor.md", model: "openai-codex/gpt-5.4" },
    ]);

    const result = await loadReviewAgents(paths, projectDir);
    expect(result.agents.length).toBe(4);
    const names = result.agents.map((a) => a.name).sort();
    expect(names).toEqual(["correctness", "maintainability", "performance-auditor", "security"]);

    const perfAgent = result.agents.find((a) => a.name === "performance-auditor");
    expect(perfAgent).toBeDefined();
    expect(perfAgent!.description).toBe("Performance auditor");
    expect(perfAgent!.focus).toBe("latency, memory");
    expect(perfAgent!.model).toBe("openai-codex/gpt-5.4");
  });

  test("ensureDefaultReviewAgents does not overwrite existing config with 4 agents", async () => {
    const agentsDir = getReviewAgentsDir(paths, projectDir);

    // Pre-create config with 4 agents
    writeAgentMarkdown(agentsDir, "security.md", "security", "Security reviewer", null, "Review for security.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "correctness.md", "correctness", "Correctness reviewer", null, "Review for correctness.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "maintainability.md", "maintainability", "Maintainability reviewer", null, "Review for maintainability.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "performance-auditor.md", "performance-auditor", "Performance auditor", null, "Review for performance.\n\n{output_instructions}");
    writeConfigYaml(agentsDir, [
      { name: "security", enabled: true, data: "security.md", model: null },
      { name: "correctness", enabled: true, data: "correctness.md", model: null },
      { name: "maintainability", enabled: true, data: "maintainability.md", model: null },
      { name: "performance-auditor", enabled: true, data: "performance-auditor.md", model: null },
    ]);

    // loadReviewAgents calls ensureDefaultReviewAgents internally — must not lose the 4th agent
    const result = await loadReviewAgents(paths, projectDir);
    expect(result.agents.length).toBe(4);
    expect(result.agents.map((a) => a.name).sort()).toEqual([
      "correctness", "maintainability", "performance-auditor", "security",
    ]);
  });

  test("creates project config without creating local default markdown files", async () => {
    const config = await loadReviewAgentsConfig(paths, projectDir);
    expect(config.agents.map((agent) => agent.name).sort()).toEqual([
      "correctness", "maintainability", "security",
    ]);

    const projectAgentsDir = getReviewAgentsDir(paths, projectDir);
    expect(fs.existsSync(path.join(projectAgentsDir, "config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(projectAgentsDir, "security.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectAgentsDir, "correctness.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectAgentsDir, "maintainability.md"))).toBe(false);
  });
});

describe("loadGlobalReviewAgents", () => {
  let tmpDir: string;
  let paths: PlatformPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agent-loader-test-"));
    paths = createTestPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads default agents from global path when no agents exist yet", async () => {
    const result = await loadGlobalReviewAgents(paths);
    expect(result.agents.length).toBe(3);
    const names = result.agents.map((a) => a.name).sort();
    expect(names).toEqual(["correctness", "maintainability", "security"]);
    for (const agent of result.agents) {
      expect(agent.scope).toBe("global");
    }
  });

  test("loads custom global agents", async () => {
    const globalDir = getGlobalReviewAgentsDir(paths);
    writeAgentMarkdown(globalDir, "perf.md", "perf", "Performance reviewer", "latency, memory", "Review for performance issues.\n\n{output_instructions}");
    writeConfigYaml(globalDir, [
      { name: "perf", enabled: true, data: "perf.md", model: null },
    ]);

    const result = await loadGlobalReviewAgents(paths);
    expect(result.agents.length).toBe(1);
    expect(result.agents[0].name).toBe("perf");
    expect(result.agents[0].scope).toBe("global");
    expect(result.agents[0].description).toBe("Performance reviewer");
  });
});

describe("loadMergedReviewAgents", () => {
  let tmpDir: string;
  let paths: PlatformPaths;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-merged-agents-test-"));
    paths = createTestPaths(tmpDir);
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("merges global and project agents", async () => {
    // Global has "perf" agent
    const globalDir = getGlobalReviewAgentsDir(paths);
    writeAgentMarkdown(globalDir, "perf.md", "perf", "Performance reviewer", null, "Review for performance.\n\n{output_instructions}");
    writeConfigYaml(globalDir, [
      { name: "perf", enabled: true, data: "perf.md", model: null },
    ]);

    // Project gets default agents
    const result = await loadMergedReviewAgents(paths, projectDir);

    const names = result.agents.map((a) => a.name).sort();
    expect(names).toContain("perf");
    expect(names).toContain("security");
    expect(names).toContain("correctness");
    expect(names).toContain("maintainability");

    const perfAgent = result.agents.find((a) => a.name === "perf");
    expect(perfAgent?.scope).toBe("global");

    const secAgent = result.agents.find((a) => a.name === "security");
    expect(secAgent?.scope).toBe("project");
  });

  test("project agents override global agents with same name", async () => {
    // Global has "security" agent
    const globalDir = getGlobalReviewAgentsDir(paths);
    writeAgentMarkdown(globalDir, "security.md", "security", "Global security", null, "Global security prompt.\n\n{output_instructions}");
    writeConfigYaml(globalDir, [
      { name: "security", enabled: true, data: "security.md", model: null },
    ]);

    // Project also has default "security" agent (ensured by loadReviewAgents)
    const result = await loadMergedReviewAgents(paths, projectDir);

    const securityAgents = result.agents.filter((a) => a.name === "security");
    expect(securityAgents.length).toBe(1);
    expect(securityAgents[0].scope).toBe("project");
  });

  test("project-disabled agent shadows globally-enabled agent", async () => {
    // Global has "security" agent enabled
    const globalDir = getGlobalReviewAgentsDir(paths);
    writeAgentMarkdown(globalDir, "security.md", "security", "Global security", null, "Global security prompt.\n\n{output_instructions}");
    writeConfigYaml(globalDir, [
      { name: "security", enabled: true, data: "security.md", model: null },
    ]);

    // Project disables "security" explicitly
    const projectAgentsDir = getReviewAgentsDir(paths, projectDir);
    writeAgentMarkdown(projectAgentsDir, "security.md", "security", "Project security", null, "Project security prompt.\n\n{output_instructions}");
    writeConfigYaml(projectAgentsDir, [
      { name: "security", enabled: false, data: "security.md", model: null },
      { name: "correctness", enabled: true, data: "correctness.md", model: null },
      { name: "maintainability", enabled: true, data: "maintainability.md", model: null },
    ]);

    const result = await loadMergedReviewAgents(paths, projectDir);

    // "security" must not appear — disabled in project config shadows global
    const securityAgents = result.agents.filter((a) => a.name === "security");
    expect(securityAgents.length).toBe(0);

    // Other project agents still present
    expect(result.agents.map((a) => a.name)).toContain("correctness");
    expect(result.agents.map((a) => a.name)).toContain("maintainability");
  });
});

describe("writeAgentFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-write-agent-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writes valid frontmatter + body", () => {
    const fileName = writeAgentFile(
      tmpDir,
      "a11y",
      { name: "a11y", description: "Accessibility reviewer", focus: "WCAG, ARIA" },
      "Check for accessibility issues.\n\n{output_instructions}",
    );

    expect(fileName).toBe("a11y.md");
    const content = fs.readFileSync(path.join(tmpDir, fileName), "utf-8");
    expect(content).toContain("name: a11y");
    expect(content).toContain("description: Accessibility reviewer");
    expect(content).toContain("focus: WCAG, ARIA");
    expect(content).toContain("Check for accessibility issues.");
    expect(content).toContain("{output_instructions}");
    // Verify it starts with frontmatter delimiters
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("\n---\n");
  });

  test("omits focus line when focus is null", () => {
    const fileName = writeAgentFile(
      tmpDir,
      "simple",
      { name: "simple", description: "Simple agent", focus: null },
      "Simple prompt.",
    );

    const content = fs.readFileSync(path.join(tmpDir, fileName), "utf-8");
    expect(content).not.toContain("focus:");
  });
});

describe("addAgentToConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-add-config-test-"));
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates new entry in existing config", async () => {
    const configPath = path.join(tmpDir, "config.yml");
    writeConfigYaml(tmpDir, [
      { name: "security", enabled: true, data: "security.md", model: null },
    ]);

    await addAgentToConfig(configPath, {
      name: "perf",
      enabled: true,
      data: "perf.md",
      model: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: null,
    });

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("name: security");
    expect(content).toContain("name: perf");
    expect(content).toContain("data: perf.md");
    expect(content).toContain("model: anthropic/claude-sonnet-4-20250514");
  });

  test("replaces existing entry with same name", async () => {
    const configPath = path.join(tmpDir, "config.yml");
    writeConfigYaml(tmpDir, [
      { name: "security", enabled: true, data: "security.md", model: null },
    ]);

    await addAgentToConfig(configPath, {
      name: "security",
      enabled: false,
      data: "security-v2.md",
      model: "openai/gpt-4o",
      thinkingLevel: null,
    });

    const content = fs.readFileSync(configPath, "utf-8");
    // Should only have one security entry
    const matches = content.match(/name: security/g);
    expect(matches?.length).toBe(1);
    expect(content).toContain("data: security-v2.md");
    expect(content).toContain("enabled: false");
  });

  describe("thinkingLevel support", () => {
    test("serializes thinkingLevel in config YAML", async () => {
      const configPath = path.join(tmpDir, "config.yml");
      writeConfigYaml(tmpDir, [
        { name: "security", enabled: true, data: "security.md", model: null },
      ]);

      await addAgentToConfig(configPath, {
        name: "perf",
        enabled: true,
        data: "perf.md",
        model: null,
        thinkingLevel: "high",
      });

      const content = fs.readFileSync(configPath, "utf-8");
      expect(content).toContain("thinkingLevel: high");
    });

    test("serializes null thinkingLevel as 'null'", async () => {
      const configPath = path.join(tmpDir, "config.yml");
      writeConfigYaml(tmpDir, []);

      await addAgentToConfig(configPath, {
        name: "test-agent",
        enabled: true,
        data: "test.md",
        model: null,
        thinkingLevel: null,
      });

      const content = fs.readFileSync(configPath, "utf-8");
      expect(content).toContain("thinkingLevel: null");
    });
  });
});

describe("thinkingLevel backward compatibility", () => {
  let tmpDir: string;
  let paths: PlatformPaths;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-thinking-compat-test-"));
    paths = createTestPaths(tmpDir);
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("config without thinkingLevel field loads successfully", async () => {
    const agentsDir = getReviewAgentsDir(paths, projectDir);
    writeConfigYaml(agentsDir, [
      { name: "a1", enabled: true, data: "a1.md", model: null },
      { name: "a2", enabled: true, data: "a2.md", model: "openai/gpt-4o" },
    ]);
    writeAgentMarkdown(agentsDir, "a1.md", "a1", "Agent one", null, "Do things.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "a2.md", "a2", "Agent two", "perf", "Do other things.\n\n{output_instructions}");

    const result = await loadReviewAgents(paths, projectDir);
    const a1 = result.agents.find((a) => a.name === "a1");
    const a2 = result.agents.find((a) => a.name === "a2");
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(a1!.thinkingLevel).toBeNull();
    expect(a2!.thinkingLevel).toBeNull();
  });

  test("config with thinkingLevel values loads correctly", async () => {
    const agentsDir = getReviewAgentsDir(paths, projectDir);
    fs.mkdirSync(agentsDir, { recursive: true });
    const configContent = [
      "agents:",
      "  - name: a1",
      "    enabled: true",
      "    data: a1.md",
      "    model: null",
      "    thinkingLevel: high",
      "  - name: a2",
      "    enabled: true",
      "    data: a2.md",
      "    model: null",
      "    thinkingLevel: null",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(agentsDir, "config.yml"), configContent);
    writeAgentMarkdown(agentsDir, "a1.md", "a1", "Agent one", null, "Do things.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "a2.md", "a2", "Agent two", null, "Do other things.\n\n{output_instructions}");

    const result = await loadReviewAgents(paths, projectDir);
    const a1 = result.agents.find((a) => a.name === "a1");
    const a2 = result.agents.find((a) => a.name === "a2");
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(a1!.thinkingLevel).toBe("high");
    expect(a2!.thinkingLevel).toBeNull();
  });

  test("buildDefaultConfigText includes thinkingLevel and comment header", async () => {
    const result = await loadReviewAgents(paths, projectDir);
    expect(result.agents.length).toBeGreaterThan(0);

    const agentsDir = getReviewAgentsDir(paths, projectDir);
    const configContent = fs.readFileSync(path.join(agentsDir, "config.yml"), "utf-8");
    expect(configContent).toContain("thinkingLevel: low");
    expect(configContent).toContain("# Review Agents Configuration");
    expect(configContent).toContain("#   thinkingLevel: string");
  });

  test("migrates pre-existing config without header or thinkingLevel", async () => {
    const agentsDir = getReviewAgentsDir(paths, projectDir);
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write a legacy config without comment header or thinkingLevel field
    const legacyConfig = [
      "agents:",
      "  - name: sec",
      "    enabled: true",
      "    data: sec.md",
      "    model: null",
      "  - name: perf",
      "    enabled: true",
      "    data: perf.md",
      "    model: openai/gpt-4o",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(agentsDir, "config.yml"), legacyConfig);
    writeAgentMarkdown(agentsDir, "sec.md", "sec", "Security", null, "Review.\n\n{output_instructions}");
    writeAgentMarkdown(agentsDir, "perf.md", "perf", "Performance", null, "Review.\n\n{output_instructions}");

    // Loading triggers the migration
    const result = await loadReviewAgents(paths, projectDir);

    // Verify agents loaded with thinkingLevel backfilled to null
    const sec = result.agents.find((a) => a.name === "sec");
    const perf = result.agents.find((a) => a.name === "perf");
    expect(sec).toBeDefined();
    expect(perf).toBeDefined();
    expect(sec!.thinkingLevel).toBeNull();
    expect(perf!.thinkingLevel).toBeNull();
    expect(perf!.model).toBe("openai/gpt-4o");

    // Verify the file was rewritten with header and thinkingLevel
    const migrated = fs.readFileSync(path.join(agentsDir, "config.yml"), "utf-8");
    expect(migrated).toStartWith("# Review Agents Configuration");
    expect(migrated).toContain("thinkingLevel: null");
    expect(migrated).toContain("model: openai/gpt-4o");
  });

  test("does not rewrite config that already has header", async () => {
    const agentsDir = getReviewAgentsDir(paths, projectDir);
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write a config that already has the header
    const modernConfig = [
      "# Review Agents Configuration",
      "#",
      "",
      "agents:",
      "  - name: sec",
      "    enabled: true",
      "    data: sec.md",
      "    model: null",
      "    thinkingLevel: high",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(agentsDir, "config.yml"), modernConfig);
    writeAgentMarkdown(agentsDir, "sec.md", "sec", "Security", null, "Review.\n\n{output_instructions}");

    await loadReviewAgents(paths, projectDir);

    // File should be unchanged — migration skipped
    const content = fs.readFileSync(path.join(agentsDir, "config.yml"), "utf-8");
    expect(content).toBe(modernConfig);
  });
});