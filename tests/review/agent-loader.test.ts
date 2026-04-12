import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadGlobalReviewAgents,
  loadMergedReviewAgents,
  writeAgentFile,
  addAgentToConfig,
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

function writeConfigYaml(dir: string, agents: Array<{ name: string; enabled: boolean; data: string; model: string | null }>): void {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    "agents:",
    ...agents.flatMap((a) => [
      `  - name: ${a.name}`,
      `    enabled: ${a.enabled}`,
      `    data: ${a.data}`,
      `    model: ${a.model ?? "null"}`,
    ]),
    "",
  ];
  fs.writeFileSync(path.join(dir, "config.yml"), lines.join("\n"));
}

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
    });

    const content = fs.readFileSync(configPath, "utf-8");
    // Should only have one security entry
    const matches = content.match(/name: security/g);
    expect(matches?.length).toBe(1);
    expect(content).toContain("data: security-v2.md");
    expect(content).toContain("enabled: false");
  });
});
