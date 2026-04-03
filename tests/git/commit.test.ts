import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  analyzeAndCommit,
  parseCommitPlan,
  buildAnalysisPrompt,
} from "../../src/git/commit.js";
import type { CommitPlan } from "../../src/git/commit.js";

// ── Helpers ────────────────────────────────────────────────

function createMockExec(responses: Record<string, { stdout: string; stderr?: string; code: number }> = {}) {
  const defaultResponse = { stdout: "", stderr: "", code: 0 };
  return vi.fn(async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    // Match by prefix for dynamic args
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.startsWith(pattern)) return { stderr: "", ...response };
    }
    return defaultResponse;
  });
}

function createMockCtx(overrides: Record<string, any> = {}) {
  const { ui: uiOverrides, ...rest } = overrides;
  return {
    cwd: "/repo",
    hasUI: true,
    ui: {
      select: vi.fn(),
      notify: vi.fn(),
      input: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      ...uiOverrides,
    },
    ...rest,
  };
}

function createMockPlatform(overrides: Record<string, any> = {}) {
  const exec = overrides.exec ?? createMockExec();
  return {
    name: "omp" as const,
    exec,
    createAgentSession: overrides.createAgentSession ?? vi.fn(),
    capabilities: {
      agentSessions: overrides.agentSessions ?? true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
      ...overrides.capabilities,
    },
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...s: string[]) => [cwd, ".omp", "supipowers", ...s].join("/"),
      global: (...s: string[]) => ["/home/.omp/supipowers", ...s].join("/"),
      agent: (...s: string[]) => ["/home/.omp/agent", ...s].join("/"),
    },
    registerCommand: vi.fn(),
    getCommands: vi.fn(() => []),
    on: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    registerMessageRenderer: vi.fn(),
    ...overrides,
  } as any;
}

/**
 * Build a mock agent session that returns a canned response.
 */
function mockAgentSession(responseJson: CommitPlan) {
  const jsonText = "```json\n" + JSON.stringify(responseJson, null, 2) + "\n```";
  return vi.fn().mockResolvedValue({
    subscribe: vi.fn((handler: any) => {
      // Fire agent_end on next tick
      setTimeout(() => handler({ type: "agent_end" }), 0);
      return () => {};
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
    state: {
      messages: [
        { role: "user", content: "..." },
        { role: "assistant", content: jsonText },
      ],
    },
    dispose: vi.fn().mockResolvedValue(undefined),
  });
}

// ── parseCommitPlan ────────────────────────────────────────

describe("parseCommitPlan", () => {
  test("parses valid single-commit plan", () => {
    const text = [
      "Here is the plan:",
      "```json",
      JSON.stringify({
        commits: [{
          type: "feat",
          scope: "auth",
          summary: "add login",
          details: ["Added /api/login"],
          files: ["src/auth.ts"],
        }],
      }),
      "```",
    ].join("\n");

    const plan = parseCommitPlan(text);
    expect(plan).not.toBeNull();
    expect(plan!.commits).toHaveLength(1);
    expect(plan!.commits[0].type).toBe("feat");
    expect(plan!.commits[0].scope).toBe("auth");
    expect(plan!.commits[0].files).toEqual(["src/auth.ts"]);
  });

  test("parses multi-commit plan", () => {
    const text = "```json\n" + JSON.stringify({
      commits: [
        { type: "feat", summary: "add feature", details: [], files: ["a.ts"] },
        { type: "fix", summary: "fix bug", details: [], files: ["b.ts"] },
      ],
    }) + "\n```";

    const plan = parseCommitPlan(text);
    expect(plan).not.toBeNull();
    expect(plan!.commits).toHaveLength(2);
  });

  test("returns null for text without JSON fence", () => {
    expect(parseCommitPlan("no json here")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseCommitPlan("```json\n{broken}\n```")).toBeNull();
  });

  test("returns null when commits array is missing", () => {
    expect(parseCommitPlan('```json\n{"foo": 1}\n```')).toBeNull();
  });

  test("returns null for empty commits array", () => {
    expect(parseCommitPlan('```json\n{"commits": []}\n```')).toBeNull();
  });

  test("returns null for invalid commit type", () => {
    const text = "```json\n" + JSON.stringify({
      commits: [{ type: "wip", summary: "x", details: [], files: ["a.ts"] }],
    }) + "\n```";
    expect(parseCommitPlan(text)).toBeNull();
  });

  test("returns null for missing files", () => {
    const text = "```json\n" + JSON.stringify({
      commits: [{ type: "feat", summary: "x", details: [], files: [] }],
    }) + "\n```";
    expect(parseCommitPlan(text)).toBeNull();
  });

  test("returns null when same file appears in multiple groups", () => {
    const text = "```json\n" + JSON.stringify({
      commits: [
        { type: "feat", summary: "a", details: [], files: ["shared.ts"] },
        { type: "fix", summary: "b", details: [], files: ["shared.ts"] },
      ],
    }) + "\n```";
    expect(parseCommitPlan(text)).toBeNull();
  });

  test("defaults scope to null when omitted", () => {
    const text = "```json\n" + JSON.stringify({
      commits: [{ type: "chore", summary: "bump deps", files: ["package.json"] }],
    }) + "\n```";
    const plan = parseCommitPlan(text);
    expect(plan!.commits[0].scope).toBeNull();
  });

  test("defaults details to empty array when omitted", () => {
    const text = "```json\n" + JSON.stringify({
      commits: [{ type: "chore", summary: "bump", files: ["package.json"] }],
    }) + "\n```";
    const plan = parseCommitPlan(text);
    expect(plan!.commits[0].details).toEqual([]);
  });
});

// ── buildAnalysisPrompt ────────────────────────────────────

describe("buildAnalysisPrompt", () => {
  test("includes full diff when under limit", () => {
    const prompt = buildAnalysisPrompt({
      diff: "diff content",
      stat: "stat content",
      fileList: ["a.ts"],
      conventions: "",
    });
    expect(prompt).toContain("Full diff");
    expect(prompt).toContain("diff content");
  });

  test("truncates diff when over 30KB", () => {
    const largeDiff = "x\n".repeat(20_000); // ~40KB
    const prompt = buildAnalysisPrompt({
      diff: largeDiff,
      stat: "1 file changed",
      fileList: ["a.ts"],
      conventions: "",
    });
    expect(prompt).toContain("truncated");
    expect(prompt).not.toContain("Full diff");
  });

  test("omits diff content when over 60KB", () => {
    const hugeDiff = "x".repeat(70_000);
    const prompt = buildAnalysisPrompt({
      diff: hugeDiff,
      stat: "1 file changed",
      fileList: ["a.ts"],
      conventions: "",
    });
    // Should not contain the diff block header at all
    expect(prompt).not.toContain("Full diff");
    expect(prompt).not.toContain("truncated");
    // But should still have stat and file list
    expect(prompt).toContain("Diff stat");
    expect(prompt).toContain("- a.ts");
  });

  test("includes conventions when provided", () => {
    const prompt = buildAnalysisPrompt({
      diff: "d",
      stat: "s",
      fileList: ["a.ts"],
      conventions: "Use angular format",
    });
    expect(prompt).toContain("Repository commit conventions");
    expect(prompt).toContain("angular format");
  });

  test("includes user context when provided", () => {
    const prompt = buildAnalysisPrompt({
      diff: "d",
      stat: "s",
      fileList: ["a.ts"],
      conventions: "",
      userContext: "fixing auth bug",
    });
    expect(prompt).toContain("Developer context");
    expect(prompt).toContain("fixing auth bug");
  });

  test("lists valid commit types", () => {
    const prompt = buildAnalysisPrompt({
      diff: "d",
      stat: "s",
      fileList: ["a.ts"],
      conventions: "",
    });
    expect(prompt).toContain("feat");
    expect(prompt).toContain("fix");
    expect(prompt).toContain("refactor");
  });
});

// ── analyzeAndCommit ───────────────────────────────────────

describe("analyzeAndCommit", () => {
  test("returns null and notifies when tree is clean", async () => {
    const exec = createMockExec({
      "git status": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({ exec });
    const ctx = createMockCtx();

    const result = await analyzeAndCommit(platform, ctx);

    expect(result).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("clean"),
      expect.any(String),
    );
  });

  test("executes single commit from agent plan", async () => {
    const plan: CommitPlan = {
      commits: [{
        type: "feat",
        scope: "auth",
        summary: "add login endpoint",
        details: ["Adds JWT support"],
        files: ["src/auth.ts"],
      }],
    };

    const exec = createMockExec({
      "git status": { stdout: " M src/auth.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "src/auth.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file changed\n", code: 0 },
      "git diff --cached": { stdout: "diff --git a/src/auth.ts\n+new code", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git reset HEAD": { stdout: "", code: 0 },
      "git add src/auth.ts": { stdout: "", code: 0 },
      "git commit": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: mockAgentSession(plan),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn().mockResolvedValue("commit — feat(auth): add login endpoint"),
        notify: vi.fn(),
        input: vi.fn(),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);

    expect(result).not.toBeNull();
    expect(result!.committed).toBe(1);
    expect(result!.messages[0]).toContain("feat(auth): add login endpoint");
  });

  test("executes split commits with file-level staging", async () => {
    const plan: CommitPlan = {
      commits: [
        { type: "refactor", scope: null, summary: "extract types", details: [], files: ["src/types.ts"] },
        { type: "feat", scope: null, summary: "add feature", details: [], files: ["src/feature.ts"] },
      ],
    };

    const exec = createMockExec({
      "git status": { stdout: " M src/types.ts\n M src/feature.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "src/types.ts\nsrc/feature.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 2 files changed\n", code: 0 },
      "git diff --cached": { stdout: "small diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git reset HEAD": { stdout: "", code: 0 },
      "git add src/types.ts": { stdout: "", code: 0 },
      "git add src/feature.ts": { stdout: "", code: 0 },
      "git commit": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: mockAgentSession(plan),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn().mockResolvedValue("commit — 2 commits"),
        notify: vi.fn(),
        input: vi.fn(),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);

    expect(result).not.toBeNull();
    expect(result!.committed).toBe(2);
    expect(result!.messages[0]).toContain("refactor: extract types");
    expect(result!.messages[1]).toContain("feat: add feature");

    // Verify reset + selective staging happened
    const execCalls = exec.mock.calls.map((c: any[]) => `${c[0]} ${c[1].join(" ")}`);
    expect(execCalls).toContain("git reset HEAD");
    expect(execCalls).toContain("git add src/types.ts");
    expect(execCalls).toContain("git add src/feature.ts");
  });

  test("falls back to manual input when agent session fails", async () => {
    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git commit": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: vi.fn().mockRejectedValue(new Error("no session")),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
        input: vi.fn().mockResolvedValue("fix: manual commit"),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);

    expect(result).not.toBeNull();
    expect(result!.committed).toBe(1);
    expect(result!.messages[0]).toBe("fix: manual commit");
    expect(ctx.ui.input).toHaveBeenCalled();
  });

  test("falls back to manual input when agent returns unparseable output", async () => {
    // Agent session that returns non-JSON
    const createAgentSession = vi.fn().mockResolvedValue({
      subscribe: vi.fn((handler: any) => {
        setTimeout(() => handler({ type: "agent_end" }), 0);
        return () => {};
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          { role: "assistant", content: "I think you should commit this as a fix." },
        ],
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    });

    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git commit": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({ exec, createAgentSession });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
        input: vi.fn().mockResolvedValue("fix: manual"),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);

    expect(result).not.toBeNull();
    expect(result!.committed).toBe(1);
    expect(ctx.ui.input).toHaveBeenCalled();
  });

  test("returns null when user selects abort", async () => {
    const plan: CommitPlan = {
      commits: [{ type: "fix", scope: null, summary: "fix bug", details: [], files: ["a.ts"] }],
    };

    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: mockAgentSession(plan),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn().mockResolvedValue("abort — cancel"),
        notify: vi.fn(),
        input: vi.fn(),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);

    expect(result).toBeNull();
    // No git commit should have been called
    const commitCalls = exec.mock.calls.filter(
      (c: any[]) => c[0] === "git" && c[1][0] === "commit",
    );
    expect(commitCalls).toHaveLength(0);
  });

  test("skips agent when agentSessions capability is false", async () => {
    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git commit": { stdout: "", code: 0 },
    });
    const createAgentSession = vi.fn();
    const platform = createMockPlatform({
      exec,
      createAgentSession,
      capabilities: { agentSessions: false },
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
        input: vi.fn().mockResolvedValue("chore: manual"),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);

    expect(createAgentSession).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.committed).toBe(1);
  });

  test("returns null when manual input is empty", async () => {
    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
        input: vi.fn().mockResolvedValue(""),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);
    expect(result).toBeNull();
  });

  test("returns null when manual commit message is invalid", async () => {
    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn(),
        notify: vi.fn(),
        input: vi.fn().mockResolvedValue("bad message no type"),
      },
    });

    const result = await analyzeAndCommit(platform, ctx);
    expect(result).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid"),
      "error",
    );
  });

  test("returns null when git add -A fails", async () => {
    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", stderr: "error", code: 1 },
    });
    const platform = createMockPlatform({ exec });
    const ctx = createMockCtx();

    const result = await analyzeAndCommit(platform, ctx);
    expect(result).toBeNull();
  });

  test("returns null when nothing staged after git add", async () => {
    const exec = createMockExec({
      "git status": { stdout: " M .gitignore", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "", code: 0 },
      "git diff --cached --stat": { stdout: "", code: 0 },
      "git diff --cached": { stdout: "", code: 0 },
      "git reset HEAD": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({ exec });
    const ctx = createMockCtx();

    const result = await analyzeAndCommit(platform, ctx);
    expect(result).toBeNull();
  });

  test("includes user context in agent prompt", async () => {
    const plan: CommitPlan = {
      commits: [{ type: "fix", scope: null, summary: "fix auth", details: [], files: ["a.ts"] }],
    };

    let capturedPrompt = "";
    const session = {
      subscribe: vi.fn((handler: any) => {
        setTimeout(() => handler({ type: "agent_end" }), 0);
        return () => {};
      }),
      prompt: vi.fn((text: string) => {
        capturedPrompt = text;
        return Promise.resolve();
      }),
      state: {
        messages: [
          {
            role: "assistant",
            content: "```json\n" + JSON.stringify(plan) + "\n```",
          },
        ],
      },
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git reset HEAD": { stdout: "", code: 0 },
      "git add a.ts": { stdout: "", code: 0 },
      "git commit": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: vi.fn().mockResolvedValue(session),
    });
    const ctx = createMockCtx({
      ui: {
        select: vi.fn().mockResolvedValue("commit — fix: fix auth"),
        notify: vi.fn(),
        input: vi.fn(),
      },
    });

    await analyzeAndCommit(platform, ctx, { userContext: "fixing the auth bug" });

    expect(capturedPrompt).toContain("fixing the auth bug");
  });

  test("shows progress widget and cleans up on completion", async () => {
    const plan: CommitPlan = { commits: [{ type: "fix", scope: null, summary: "fix bug", details: [], files: ["a.ts"] }] };
    const exec = createMockExec({
      "git status": { stdout: " M a.ts", code: 0 },
      "git add -A": { stdout: "", code: 0 },
      "git diff --cached --name-only": { stdout: "a.ts\n", code: 0 },
      "git diff --cached --stat": { stdout: " 1 file\n", code: 0 },
      "git diff --cached": { stdout: "small diff", code: 0 },
      "git config commit.template": { stdout: "", code: 1 },
      "git reset HEAD": { stdout: "", code: 0 },
      "git add a.ts": { stdout: "", code: 0 },
      "git commit": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({
      exec,
      createAgentSession: mockAgentSession(plan),
    });
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = createMockCtx({
      ui: {
        select: vi.fn().mockResolvedValue("commit — fix: fix bug"),
        notify: vi.fn(),
        input: vi.fn(),
        setWidget,
        setStatus,
      },
    });

    const result = await analyzeAndCommit(platform, ctx);
    expect(result).not.toBeNull();
    expect(result!.committed).toBe(1);

    // Widget was shown during the flow (called multiple times for progress)
    expect(setWidget).toHaveBeenCalled();
    const widgetCalls = setWidget.mock.calls;

    // Last widget call clears it (dispose)
    const lastCall = widgetCalls[widgetCalls.length - 1];
    expect(lastCall[0]).toBe("supi-commit");
    expect(lastCall[1]).toBeUndefined();

    // Status was shown during the flow (animated spinner)
    expect(setStatus).toHaveBeenCalled();
    const statusCalls = setStatus.mock.calls;

    // Last status call clears it (dispose)
    const lastStatusCall = statusCalls[statusCalls.length - 1];
    expect(lastStatusCall[0]).toBe("supi-commit");
    expect(lastStatusCall[1]).toBeUndefined();
  });

  test("cleans up progress widget on early exit (clean tree)", async () => {
    const exec = createMockExec({
      "git status": { stdout: "", code: 0 },
    });
    const platform = createMockPlatform({ exec });
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = createMockCtx({
      ui: { setWidget, setStatus, notify: vi.fn() },
    });

    const result = await analyzeAndCommit(platform, ctx);
    expect(result).toBeNull();

    // Widget was set and then cleaned up
    expect(setWidget).toHaveBeenCalled();
    const lastCall = setWidget.mock.calls[setWidget.mock.calls.length - 1];
    expect(lastCall[0]).toBe("supi-commit");
    expect(lastCall[1]).toBeUndefined();
  });
});
