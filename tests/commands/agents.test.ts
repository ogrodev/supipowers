import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../src/platform/types.js";
import { handleAgents, registerAgentsCommand, runAgentCreateFlow } from "../../src/commands/agents.js";

function createTestPaths(rootDir: string) {
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

function createPlatform(localPaths: ReturnType<typeof createTestPaths>): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec: mock(),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: localPaths,
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

function writePackageJson(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data, null, 2));
}

function setupWorkspaceRepo(repoRoot: string, workspaceRelativeDir = "packages/app"): string {
  writePackageJson(repoRoot, {
    name: "repo-root",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/*"],
  });
  const workspaceDir = path.join(repoRoot, workspaceRelativeDir);
  writePackageJson(workspaceDir, {
    name: "app",
    version: "1.0.0",
    private: true,
  });
  return workspaceDir;
}

describe("registerAgentsCommand", () => {
  test("registers supi:agents command", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agents-reg-"));
    const localPaths = createTestPaths(tmpDir);
    const platform = createPlatform(localPaths);

    registerAgentsCommand(platform);

    expect(platform.registerCommand).toHaveBeenCalledWith(
      "supi:agents",
      expect.objectContaining({ description: expect.any(String) }),
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("autocomplete returns 'create' suggestion", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agents-ac-"));
    const localPaths = createTestPaths(tmpDir);
    const platform = createPlatform(localPaths);

    registerAgentsCommand(platform);

    const registerCall = (platform.registerCommand as any).mock.calls[0];
    const opts = registerCall[1];
    const completions = opts.getArgumentCompletions("cr");

    expect(completions).toEqual([
      { value: "create ", label: "create", description: "Create a new review agent" },
    ]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("autocomplete returns null for non-matching prefix", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agents-ac2-"));
    const localPaths = createTestPaths(tmpDir);
    const platform = createPlatform(localPaths);

    registerAgentsCommand(platform);

    const registerCall = (platform.registerCommand as any).mock.calls[0];
    const opts = registerCall[1];
    const completions = opts.getArgumentCompletions("xyz");

    expect(completions).toBeNull();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("handleAgents — list view", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createTestPaths>;
  let platform: Platform;
  let ctx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agents-list-"));
    localPaths = createTestPaths(tmpDir);
    platform = createPlatform(localPaths);
    ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select: mock(),
        notify: mock(),
        input: mock(),
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("solo invocation renders agent dashboard", async () => {
    handleAgents(platform, ctx);

    // Wait for async dashboard rendering
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(ctx.ui.notify).toHaveBeenCalled();
    const notifyCall = (ctx.ui.notify as any).mock.calls[0];
    const dashboard = notifyCall[0];
    expect(dashboard).toContain("Review Agents");
    expect(dashboard).toContain("agent(s)");
  });

  test("dashboard shows workspace provenance when cwd is inside a workspace", async () => {
    const workspaceDir = setupWorkspaceRepo(tmpDir);
    ctx.cwd = workspaceDir;

    const globalAgentsDir = path.join(tmpDir, "global-config", ".omp", "supipowers", "review-agents");
    fs.mkdirSync(globalAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalAgentsDir, "perf.md"),
      "---\nname: perf\ndescription: Global perf\n---\n\nGlobal perf prompt.\n\n{output_instructions}\n",
    );
    fs.writeFileSync(
      path.join(globalAgentsDir, "config.yml"),
      [
        "agents:",
        "  - name: perf",
        "    enabled: true",
        "    data: perf.md",
        "    model: null",
        "    thinkingLevel: null",
        "",
      ].join("\n"),
    );

    const workspaceAgentsDir = path.join(
      tmpDir,
      ".omp",
      "supipowers",
      "workspaces",
      "packages",
      "app",
      "review-agents",
    );
    fs.mkdirSync(workspaceAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceAgentsDir, "ux.md"),
      "---\nname: ux\ndescription: Workspace UX\n---\n\nWorkspace UX prompt.\n\n{output_instructions}\n",
    );
    fs.writeFileSync(
      path.join(workspaceAgentsDir, "config.yml"),
      [
        "agents:",
        "  - name: ux",
        "    enabled: true",
        "    data: ux.md",
        "    model: openai/gpt-4o",
        "    thinkingLevel: null",
        "",
      ].join("\n"),
    );

    handleAgents(platform, ctx);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const dashboard = (ctx.ui.notify as any).mock.calls[0][0];
    expect(dashboard).toContain("Workspace: packages/app");
    expect(dashboard).toContain("Effective precedence: workspace → root → global");
    expect(dashboard).toContain("workspace");
    expect(dashboard).toContain("root");
    expect(dashboard).toContain("global");
  });

  test("with 'create' arg delegates to create flow", async () => {
    // Mock all UI methods to return null (cancel)
    (ctx.ui.select as any).mockResolvedValue(null);

    handleAgents(platform, ctx, "create");

    // Wait for async flow
    await new Promise((resolve) => setTimeout(resolve, 200));

    // select was called (scope selection prompt)
    expect(ctx.ui.select).toHaveBeenCalled();
  });
});

describe("runAgentCreateFlow — send a prompt", () => {
  let tmpDir: string;
  let localPaths: ReturnType<typeof createTestPaths>;
  let platform: Platform;
  let ctx: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-agents-create-"));
    localPaths = createTestPaths(tmpDir);
    platform = createPlatform(localPaths);
    ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: {
        select: mock(),
        notify: mock(),
        input: mock(),
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates agent file and config when user sends a prompt", async () => {
    // Scope: project
    (ctx.ui.select as any).mockResolvedValueOnce("This project");
    // Name
    (ctx.ui.input as any).mockResolvedValueOnce("perf-review");
    // Model (selectModelFromList uses ctx.ui.custom or ctx.ui.select)
    (ctx.ui.select as any).mockResolvedValueOnce("anthropic/claude-sonnet-4-20250514");
    // Thinking level
    (ctx.ui.select as any).mockResolvedValueOnce("Inherit (model default)");
    // Prompt source
    (ctx.ui.select as any).mockResolvedValueOnce("Send a prompt");
    // Prompt body
    (ctx.ui.input as any).mockResolvedValueOnce("Review for performance issues.\n\n{output_instructions}");

    await runAgentCreateFlow(platform, ctx);

    // Verify success notification
    const notifyCalls = (ctx.ui.notify as any).mock.calls;
    const successCall = notifyCalls.find((c: any) => c[0].includes("created"));
    expect(successCall).toBeTruthy();
    expect(successCall[0]).toContain("perf-review");
    expect(successCall[0]).toContain("project");

    // Verify the agent file was written
    const agentFile = path.join(tmpDir, ".omp", "supipowers", "review-agents", "perf-review.md");
    expect(fs.existsSync(agentFile)).toBe(true);
    const content = fs.readFileSync(agentFile, "utf-8");
    expect(content).toContain("name: perf-review");
    expect(content).toContain("Review for performance issues.");

    // Verify config was updated
    const configFile = path.join(tmpDir, ".omp", "supipowers", "review-agents", "config.yml");
    const configContent = fs.readFileSync(configFile, "utf-8");
    expect(configContent).toContain("name: perf-review");
  });

  test("cancels gracefully when scope is cancelled", async () => {
    (ctx.ui.select as any).mockResolvedValueOnce(null);

    await runAgentCreateFlow(platform, ctx);

    // No error notification
    const errorCalls = (ctx.ui.notify as any).mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(0);
  });

  test("cancels gracefully when name is cancelled", async () => {
    (ctx.ui.select as any).mockResolvedValueOnce("This project");
    (ctx.ui.input as any).mockResolvedValueOnce(null);

    await runAgentCreateFlow(platform, ctx);

    const errorCalls = (ctx.ui.notify as any).mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(0);
  });

  test("rejects invalid agent name", async () => {
    (ctx.ui.select as any).mockResolvedValueOnce("This project");
    (ctx.ui.input as any).mockResolvedValueOnce("My Bad Name!");

    await runAgentCreateFlow(platform, ctx);

    const errorCalls = (ctx.ui.notify as any).mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][0]).toContain("kebab-case");
  });

  test("detects name collision in target scope", async () => {
    // Pre-create an agent named "security" (project scope via defaults)
    (ctx.ui.select as any).mockResolvedValueOnce("This project");
    (ctx.ui.input as any).mockResolvedValueOnce("security");

    await runAgentCreateFlow(platform, ctx);

    const errorCalls = (ctx.ui.notify as any).mock.calls.filter((c: any) => c[1] === "error");
    expect(errorCalls.length).toBe(1);
    expect(errorCalls[0][0]).toContain("already exists");
  });

  test("'Create from zero' sends steer message", async () => {
    (ctx.ui.select as any).mockResolvedValueOnce("Global");
    (ctx.ui.input as any).mockResolvedValueOnce("a11y");
    // Model picker
    (ctx.ui.select as any).mockResolvedValueOnce(null); // cancel model = null (inherit)
    // Thinking level
    (ctx.ui.select as any).mockResolvedValueOnce("Inherit (model default)");
    // Prompt source
    (ctx.ui.select as any).mockResolvedValueOnce("Create from zero");

    await runAgentCreateFlow(platform, ctx);

    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-agents-create",
        display: "none",
      }),
      expect.objectContaining({
        deliverAs: "steer",
        triggerTurn: true,
      }),
    );

    // Verify the steer prompt contains the agent details
    const sendCall = (platform.sendMessage as any).mock.calls[0];
    const steerContent = sendCall[0].content[0].text;
    expect(steerContent).toContain("a11y");
    expect(steerContent).toContain("global");
    // Verify the skill content is embedded (not a skill:// reference)
    expect(steerContent).toContain("Creating a Review Agent");
    expect(steerContent).not.toContain("skill://creating-supi-agents");
  });

  test("warns when not in interactive mode", async () => {
    ctx.hasUI = false;

    await runAgentCreateFlow(platform, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Agent creation requires interactive mode",
      "warning",
    );
  });
});
