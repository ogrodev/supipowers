import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../../src/platform/types.js";
import { registerFixPrCommand } from "../../src/commands/fix-pr.js";
import { DEFAULT_FIX_PR_CONFIG } from "../../src/fix-pr/config.js";

let tmpDir: string;

function writePackageJson(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data, null, 2));
}

function setupWorkspaceRepo(repoRoot: string): string {
  writePackageJson(repoRoot, {
    name: "repo-root",
    version: "1.0.0",
    private: true,
    packageManager: "bun@1.3.10",
    workspaces: ["packages/*"],
  });
  const workspaceDir = path.join(repoRoot, "packages", "pkg-a");
  writePackageJson(workspaceDir, {
    name: "pkg-a",
    version: "1.0.0",
    private: true,
  });
  return workspaceDir;
}

function createPaths(rootDir: string) {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(rootDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

function createPlatform(exec: Platform["exec"], rootDir: string): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => []),
    on: mock(),
    exec,
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: createPaths(rootDir),
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
  } as unknown as Platform;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fix-pr-cmd-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("registerFixPrCommand", () => {
  test("parses PR number when --target uses a separate token", async () => {
    const workspaceDir = setupWorkspaceRepo(tmpDir);
    const exec = mock(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "owner/repo\n", stderr: "", code: 0 };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        expect(opts?.cwd).toBe(workspaceDir);
        return { stdout: `${tmpDir}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    });
    const platform = createPlatform(exec as Platform["exec"], tmpDir);
    const ctx = {
      cwd: workspaceDir,
      hasUI: false,
      ui: {
        notify: mock(),
        select: mock(),
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    registerFixPrCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;

    await handler("--target pkg-a #123", ctx);

    expect(exec.mock.calls.some((call: any[]) => call[0] === "gh" && call[1][0] === "pr" && call[1][1] === "view")).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No fix-pr config"), "error");
  });

  test("parses PR number when --target uses the equals form", async () => {
    const workspaceDir = setupWorkspaceRepo(tmpDir);
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "owner/repo\n", stderr: "", code: 0 };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { stdout: `${tmpDir}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    });
    const platform = createPlatform(exec as Platform["exec"], tmpDir);
    const ctx = {
      cwd: workspaceDir,
      hasUI: false,
      ui: {
        notify: mock(),
        select: mock(),
        input: mock(),
        setStatus: mock(),
      },
    } as any;

    registerFixPrCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;

    await handler("--target=pkg-a 456", ctx);

    expect(exec.mock.calls.some((call: any[]) => call[0] === "gh" && call[1][0] === "pr" && call[1][1] === "view")).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No fix-pr config"), "error");
  });

  test("surfaces unscoped comments separately from root target batches", async () => {
    const workspaceDir = setupWorkspaceRepo(tmpDir);
    const commentsJsonl = [
      JSON.stringify({
        id: 1,
        path: "packages/pkg-a/src/index.ts",
        line: 1,
        body: "package comment",
        user: "reviewer",
        userType: "User",
        createdAt: "2026-04-16T00:00:00Z",
        updatedAt: "2026-04-16T00:00:00Z",
        inReplyToId: null,
        diffHunk: null,
        state: "COMMENTED",
      }),
      JSON.stringify({
        id: 2,
        path: "README.md",
        line: 1,
        body: "root comment",
        user: "reviewer",
        userType: "User",
        createdAt: "2026-04-16T00:00:00Z",
        updatedAt: "2026-04-16T00:00:00Z",
        inReplyToId: null,
        diffHunk: null,
        state: "COMMENTED",
      }),
      JSON.stringify({
        id: 3,
        path: null,
        line: null,
        body: "review summary",
        user: "reviewer",
        userType: "User",
        createdAt: "2026-04-16T00:00:00Z",
        updatedAt: "2026-04-16T00:00:00Z",
        inReplyToId: null,
        diffHunk: null,
        state: "COMMENTED",
      }),
    ].join("\n");
    fs.mkdirSync(path.join(workspaceDir, ".omp", "supipowers"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, ".omp", "supipowers", "fix-pr.json"),
      JSON.stringify(DEFAULT_FIX_PR_CONFIG),
    );

    const exec = mock(async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
        return { stdout: "owner/repo\n", stderr: "", code: 0 };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        expect(opts?.cwd).toBe(workspaceDir);
        return { stdout: `${tmpDir}\n`, stderr: "", code: 0 };
      }
      if (cmd === "gh" && args[0] === "api" && args[2] === "repos/owner/repo/pulls/123/comments") {
        return { stdout: `${commentsJsonl}\n`, stderr: "", code: 0 };
      }
      if (cmd === "gh" && args[0] === "api" && args[2] === "repos/owner/repo/pulls/123/reviews") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    });
    const platform = createPlatform(exec as Platform["exec"], tmpDir);
    const ctx = {
      cwd: workspaceDir,
      hasUI: false,
      ui: {
        notify: mock(),
        select: mock(),
        input: mock(),
        setStatus: mock(),
      },
    } as any;
    const assessmentJson = JSON.stringify({
      assessments: [{
        commentId: 1,
        verdict: "apply",
        rationale: "Reviewer correctly flagged an issue.",
        affectedFiles: ["packages/pkg-a/src/index.ts"],
        rippleEffects: [],
        verificationPlan: "bun test",
      }],
    });
    (platform as any).createAgentSession = mock(async () => {
      const messages: any[] = [];
      return {
        state: { get messages() { return messages; } },
        async prompt() { messages.push({ role: "assistant", content: assessmentJson }); },
        async dispose() {},
      };
    });

    registerFixPrCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;

    await handler("--target pkg-a #123", ctx);

    expect(platform.sendMessage).toHaveBeenCalledTimes(1);
    const prompt = (platform.sendMessage as any).mock.calls[0][0].content[0].text;
    expect(prompt).toContain("Deferred comments outside this target: root (.): 1 comment; unscoped review comments: 1 comment without file path");
    expect(prompt).toContain('"id":1');
    expect(prompt).toContain('"commentId": 1');
    expect(prompt).toContain("wait-and-check.ts");
    expect(prompt).toContain("trigger-review.ts");
    expect(prompt).not.toContain("wait-and-check.sh");
    expect(prompt).not.toContain("trigger-review.sh");
    expect(prompt).not.toContain('"id":2');
    expect(prompt).not.toContain('"id":3');
  });
});
