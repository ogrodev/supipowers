
import { formatCheckResult, formatSummary, checkPlatform, checkConfig, checkStorage, checkEventStore, checkGit, checkGitHubCli, checkLsp, checkMcp, checkContextMode, checkNpm, checkCapabilities, runDoctorChecks } from "../../src/commands/doctor.js";
import type { Platform } from "../../src/platform/types.js";

describe("doctor formatting", () => {
  it("formats a passing two-phase check", () => {
    const result = {
      name: "Git",
      presence: { ok: true, detail: "v2.43.0" },
      functional: { ok: true, detail: "Repo detected (main)" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  Git .............. ✓ v2.43.0",
      "                     ✓ Repo detected (main)",
    ]);
  });

  it("formats a failing presence check with no functional", () => {
    const result = {
      name: "GitHub CLI",
      presence: { ok: false, detail: "not found" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  GitHub CLI ....... ✗ not found",
    ]);
  });

  it("formats a presence-only passing check", () => {
    const result = {
      name: "LSP",
      presence: { ok: true, detail: "LSP tools detected" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  LSP .............. ✓ LSP tools detected",
    ]);
  });

  it("formats presence pass + functional fail", () => {
    const result = {
      name: "npm",
      presence: { ok: true, detail: "v10.8.0" },
      functional: { ok: false, detail: "Registry unreachable" },
    };
    const lines = formatCheckResult(result);
    expect(lines).toEqual([
      "  npm .............. ✓ v10.8.0",
      "                     ✗ Registry unreachable",
    ]);
  });

  it("counts core infra presence failures as critical", () => {
    const sections = [
      {
        title: "Core Infrastructure",
        checks: [
          { name: "Platform", presence: { ok: true, detail: "" }, functional: { ok: true, detail: "" } },
          { name: "Config", presence: { ok: true, detail: "" }, functional: { ok: false, detail: "" } },
          { name: "Git", presence: { ok: false, detail: "" } },
        ],
      },
      {
        title: "Integrations",
        checks: [
          { name: "npm", presence: { ok: false, detail: "" } },
        ],
      },
    ];
    const summary = formatSummary(sections);
    expect(summary).toContain("1 passed");
    expect(summary).toContain("2 warnings"); // Config functional fail + npm presence fail
    expect(summary).toContain("1 critical"); // Git presence fail is critical (core infra)
  });
});

describe("core infrastructure checks", () => {
  const mockPlatform = (overrides?: Partial<Platform>) => ({
    name: "omp" as const,
    exec: async (cmd: string, args: string[]) => ({ stdout: "", stderr: "", code: 0 }),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...s: string[]) => `/tmp/test/.omp/supipowers/${s.join("/")}`,
      global: (...s: string[]) => `/tmp/test-global/.omp/supipowers/${s.join("/")}`,
      agent: (...s: string[]) => `/tmp/test-global/.omp/agent/${s.join("/")}`,
    },
    capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
    ...overrides,
  } as unknown as Platform);

  it("checkPlatform reports platform name and exec status", async () => {
    const p = mockPlatform({
      exec: async () => ({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    const result = await checkPlatform(p);
    expect(result.name).toBe("Platform");
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("OMP");
    expect(result.functional!.ok).toBe(true);
  });

  it("checkPlatform reports exec failure", async () => {
    const p = mockPlatform({
      exec: async () => { throw new Error("boom"); },
    });
    const result = await checkPlatform(p);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(false);
  });

  it("checkGit detects version and repo", async () => {
    const p = mockPlatform({
      exec: async (cmd: string, args: string[]) => {
        if (args[0] === "--version") return { stdout: "git version 2.43.0", stderr: "", code: 0 };
        if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "", code: 0 };
        if (args[0] === "branch") return { stdout: "feat/doctor\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 1 };
      },
    });
    const result = await checkGit(p);
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("2.43.0");
    expect(result.functional!.ok).toBe(true);
    expect(result.functional!.detail).toContain("feat/doctor");
  });

  it("checkGit reports missing git", async () => {
    const p = mockPlatform({
      exec: async () => ({ stdout: "", stderr: "", code: 127 }),
    });
    const result = await checkGit(p);
    expect(result.presence.ok).toBe(false);
  });

  it("checkEventStore delegates to dependency registry", async () => {
    const result = await checkEventStore();
    // In Node/Vitest env, bun:sqlite is not available — registry returns not installed
    expect(result.name).toBe("EventStore");
    expect(typeof result.presence.ok).toBe("boolean");
    expect(typeof result.presence.detail).toBe("string");
  });
});

describe("integration checks", () => {
  const mockPlatform = (execFn: Platform["exec"]) => ({
    name: "omp" as const,
    exec: execFn,
    getActiveTools: () => [] as string[],
    paths: { dotDir: ".omp" },
    capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
  } as unknown as Platform);

  it("checkGitHubCli detects version and auth", async () => {
    const p = mockPlatform(async (cmd, args) => {
      if (cmd === "gh" && args[0] === "--version") return { stdout: "gh version 2.62.0 (2024-10-01)\n", stderr: "", code: 0 };
      if (cmd === "gh" && args[0] === "auth") return { stdout: "", stderr: "Logged in to github.com account pedromendes", code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    });
    const result = await checkGitHubCli(p);
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("2.62.0");
    expect(result.functional!.ok).toBe(true);
    expect(result.functional!.detail).toContain("pedromendes");
  });

  it("checkMcp detects tools and counts servers", () => {
    const tools = [
      "mcp__plugin_figma_figma__get_screenshot",
      "mcp__plugin_figma_figma__get_metadata",
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "bash",
      "read",
    ];
    const result = checkMcp(tools);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.detail).toContain("3 tools");
    expect(result.functional!.detail).toContain("2 servers");
  });

  it("checkMcp reports no MCP tools", () => {
    const result = checkMcp(["bash", "read", "edit"]);
    expect(result.presence.ok).toBe(false);
    expect(result.presence.detail).toContain("No MCP tools");
  });

  it("checkContextMode uses detectContextMode", () => {
    const tools = [
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_search",
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
    ];
    const result = checkContextMode(tools);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(true);
    expect(result.functional!.detail).toContain("ctx_execute");
    expect(result.functional!.detail).toContain("ctx_search");
  });

  it("checkLsp detects lsp tool", () => {
    const result = checkLsp(["bash", "lsp", "read"]);
    expect(result.presence.ok).toBe(true);
  });

  it("checkLsp reports missing lsp", () => {
    const result = checkLsp(["bash", "read"]);
    expect(result.presence.ok).toBe(false);
  });

  it("checkNpm detects version and registry", async () => {
    const p = mockPlatform(async (cmd, args) => {
      if (cmd === "npm" && args[0] === "--version") return { stdout: "10.8.0\n", stderr: "", code: 0 };
      if (cmd === "npm" && args[0] === "ping") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    });
    const result = await checkNpm(p);
    expect(result.presence.ok).toBe(true);
    expect(result.presence.detail).toContain("10.8.0");
    expect(result.functional!.ok).toBe(true);
  });

  it("checkNpm reports missing npm", async () => {
    const p = mockPlatform(async () => ({ stdout: "", stderr: "", code: 127 }));
    const result = await checkNpm(p);
    expect(result.presence.ok).toBe(false);
  });

  it("checkNpm reports unreachable registry", async () => {
    const p = mockPlatform(async (cmd, args) => {
      if (cmd === "npm" && args[0] === "--version") return { stdout: "10.8.0\n", stderr: "", code: 0 };
      if (cmd === "npm" && args[0] === "ping") return { stdout: "", stderr: "", code: 1 };
      return { stdout: "", stderr: "", code: 1 };
    });
    const result = await checkNpm(p);
    expect(result.presence.ok).toBe(true);
    expect(result.functional!.ok).toBe(false);
  });
});

describe("runDoctorChecks", () => {
  it("returns three sections", async () => {
    const platform = {
      name: "omp" as const,
      exec: async (cmd: string, args: string[]) => {
        if (cmd === "echo") return { stdout: "ok\n", stderr: "", code: 0 };
        if (cmd === "git" && args[0] === "--version") return { stdout: "git version 2.43.0", stderr: "", code: 0 };
        if (cmd === "git" && args[0] === "rev-parse") return { stdout: "true\n", stderr: "", code: 0 };
        if (cmd === "git" && args[0] === "branch") return { stdout: "main\n", stderr: "", code: 0 };
        if (cmd === "gh") return { stdout: "", stderr: "", code: 127 };
        if (cmd === "npm" && args[0] === "--version") return { stdout: "10.8.0\n", stderr: "", code: 0 };
        if (cmd === "npm" && args[0] === "ping") return { stdout: "", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 1 };
      },
      getActiveTools: () => ["bash", "read", "lsp"],
      paths: {
        dotDir: ".omp",
        dotDirDisplay: ".omp",
        project: (cwd: string, ...s: string[]) => `/tmp/.omp/supipowers/${s.join("/")}`,
        global: (...s: string[]) => `/tmp/global/.omp/supipowers/${s.join("/")}`,
        agent: (...s: string[]) => `/tmp/global/.omp/agent/${s.join("/")}`,
      },
      capabilities: { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: false },
    } as unknown as Platform;

    const sections = await runDoctorChecks(platform, "/tmp/test");
    expect(sections).toHaveLength(3);
    expect(sections[0].title).toBe("Core Infrastructure");
    expect(sections[1].title).toBe("Integrations");
    expect(sections[2].title).toBe("Platform Capabilities");
  });
});

describe("platform capabilities", () => {
  it("maps capabilities to feature descriptions", () => {
    const caps = { agentSessions: true, compactionHooks: true, customWidgets: false, registerTool: true };
    const mcpAvailable = true;
    const results = checkCapabilities(caps, mcpAvailable);
    expect(results).toHaveLength(4);

    const widgets = results.find((r) => r.name === "customWidgets");
    expect(widgets!.presence.ok).toBe(false);
    expect(widgets!.presence.detail).toContain("Progress widgets");

    const mcp = results.find((r) => r.name === "MCP");
    expect(mcp!.presence.ok).toBe(true);
  });

  it("reports MCP not detected", () => {
    const caps = { agentSessions: true, compactionHooks: true, customWidgets: true, registerTool: true };
    const results = checkCapabilities(caps, false);
    const mcp = results.find((r) => r.name === "MCP");
    expect(mcp!.presence.ok).toBe(false);
  });
});
