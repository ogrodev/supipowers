import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform, PlatformPaths } from "../../src/platform/types.js";
import type { DocDriftState } from "../../src/types.js";
import { registerGenerateCommand } from "../../src/commands/generate.js";
import {
  discoverDocFiles,
  loadState,
  saveState,
  statePath,
} from "../../src/docs/drift.js";
import { detectPackageManager } from "../../src/workspace/package-manager.js";
import { discoverWorkspaceTargets } from "../../src/workspace/targets.js";

// ── Fixtures ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-gen-test-"));
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "root-app", version: "1.0.0" }, null, 2),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createPaths(baseDir?: string): PlatformPaths {
  const dir = baseDir ?? tmpDir;
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(dir, ...segments),
    agent: (...segments: string[]) => path.join(dir, ...segments),
  };
}

function createPlatform(overrides: Partial<Platform> = {}): Platform {
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
    paths: createPaths(),
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
    },
    ...overrides,
  } as unknown as Platform;
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      notify: mock(),
      select: mock(),
      input: mock(),
      confirm: mock(),
    },
    ...overrides,
  } as any;
}

function createWorkspaceRepo(): void {
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({
      name: "root-app",
      version: "1.0.0",
      workspaces: ["packages/*"],
    }, null, 2),
  );
  fs.mkdirSync(path.join(tmpDir, "packages", "pkg-a"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "packages", "pkg-b"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "packages", "pkg-a", "package.json"),
    JSON.stringify({ name: "pkg-a", version: "1.0.0" }, null, 2),
  );
  fs.writeFileSync(
    path.join(tmpDir, "packages", "pkg-b", "package.json"),
    JSON.stringify({ name: "pkg-b", version: "1.0.0" }, null, 2),
  );
}

// ── State persistence ─────────────────────────────────────────

describe("state persistence", () => {
  test("loadState returns empty state when file does not exist", () => {
    const paths = createPaths();
    const state = loadState(paths, tmpDir);
    expect(state).toEqual({
      trackedFiles: [],
      lastCommit: null,
      lastRunAt: null,
    });
  });

  test("saveState and loadState round-trip", () => {
    const paths = createPaths();
    const state: DocDriftState = {
      trackedFiles: ["README.md", "docs/guide.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-10T12:00:00.000Z",
    };
    saveState(paths, tmpDir, state);
    const loaded = loadState(paths, tmpDir);
    expect(loaded).toEqual(state);
  });

  test("saveState creates directories recursively", () => {
    const paths = createPaths();
    const file = statePath(paths, tmpDir);
    // Ensure parent doesn't exist yet
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    saveState(paths, tmpDir, { trackedFiles: ["a.md"], lastCommit: null, lastRunAt: null });
    expect(fs.existsSync(file)).toBe(true);
  });

  test("loadState handles corrupt JSON gracefully", () => {
    const paths = createPaths();
    const file = statePath(paths, tmpDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not-json{{{");
    const state = loadState(paths, tmpDir);
    expect(state.trackedFiles).toEqual([]);
    expect(state.lastCommit).toBeNull();
  });
});

// ── File discovery ────────────────────────────────────────────

describe("discoverDocFiles", () => {
  test("parses git ls-files output into sorted unique list", async () => {
    const platform = createPlatform({
      exec: mock(async () => ({
        code: 0,
        stdout: "README.md\ndocs/guide.md\nCHANGELOG.md\nREADME.md\n",
        stderr: "",
      })),
    } as any);

    const files = await discoverDocFiles(platform, "/repo");
    expect(files).toEqual(["CHANGELOG.md", "README.md", "docs/guide.md"]);
  });

  test("returns empty array on git failure", async () => {
    const platform = createPlatform({
      exec: mock(async () => ({
        code: 128,
        stdout: "",
        stderr: "not a git repository",
      })),
    } as any);

    const files = await discoverDocFiles(platform, "/repo");
    expect(files).toEqual([]);
  });

  test("handles empty output", async () => {
    const platform = createPlatform({
      exec: mock(async () => ({
        code: 0,
        stdout: "\n",
        stderr: "",
      })),
    } as any);

    const files = await discoverDocFiles(platform, "/repo");
    expect(files).toEqual([]);
  });
});

// ── Command registration ──────────────────────────────────────

describe("registerGenerateCommand", () => {
  test("registers supi:generate command", () => {
    const platform = createPlatform();
    registerGenerateCommand(platform);
    expect(platform.registerCommand).toHaveBeenCalledWith(
      "supi:generate",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  test("unknown subcommand notifies error", async () => {
    const platform = createPlatform();
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;
    const ctx = createContext();
    await handler("bogus", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("bogus"),
      "error",
    );
  });

  test("defaults to docs subcommand when no args", async () => {
    // When no args, should attempt docs flow — needs exec for git
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "ls-files") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const platform = createPlatform({ exec } as any);
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;
    const ctx = createContext();

    // No files discovered → warns, which proves it entered the docs flow
    await handler(undefined, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No documentation files found"),
      "warning",
    );
  });
});

describe("getArgumentCompletions", () => {
  test("returns docs subcommand when prefix matches", () => {
    const platform = createPlatform();
    registerGenerateCommand(platform);
    const opts = (platform.registerCommand as any).mock.calls[0][1];
    const completions = opts.getArgumentCompletions("d");
    expect(completions).toEqual([
      { value: "docs ", label: "docs", description: expect.any(String) },
    ]);
  });

  test("returns all subcommands for empty prefix", () => {
    const platform = createPlatform();
    registerGenerateCommand(platform);
    const opts = (platform.registerCommand as any).mock.calls[0][1];
    const completions = opts.getArgumentCompletions("");
    expect(completions).not.toBeNull();
    expect(completions!.length).toBeGreaterThanOrEqual(1);
    expect(completions![0].label).toBe("docs");
  });

  test("returns null when no match", () => {
    const platform = createPlatform();
    registerGenerateCommand(platform);
    const opts = (platform.registerCommand as any).mock.calls[0][1];
    const completions = opts.getArgumentCompletions("xyz");
    expect(completions).toBeNull();
  });
});

// ── Docs flow integration ─────────────────────────────────────

describe("docs flow", () => {
  test("first run: discovers files, shows select, saves state, steers main thread", async () => {
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "ls-files") {
        return { code: 0, stdout: "README.md\ndocs/setup.md\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const platform = createPlatform({ exec } as any);
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;

    // Simulate select: user picks README.md then clicks Done
    let selectCount = 0;
    const ctx = createContext({
      ui: {
        notify: mock(),
        select: mock(async () => {
          selectCount++;
          if (selectCount === 1) return "○ README.md";
          return "─── Done ───";
        }),
        input: mock(),
        confirm: mock(),
      },
    });

    await handler("docs", ctx);

    // State should be saved with null lastCommit (deferred until fix starts)
    const state = loadState(platform.paths, tmpDir);
    expect(state.trackedFiles).toEqual(["README.md"]);
    expect(state.lastCommit).toBeNull();
    expect(state.lastRunAt).not.toBeNull();

    // Should steer main thread to audit and fix docs directly
    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-generate-docs",
        content: [{ type: "text", text: expect.stringContaining("fix it directly") }],
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  test("first run with --target scopes docs and state to one workspace package", async () => {
    createWorkspaceRepo();
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "ls-files") {
        return {
          code: 0,
          stdout: [
            "README.md",
            "packages/pkg-a/README.md",
            "packages/pkg-a/docs/setup.md",
            "packages/pkg-b/README.md",
          ].join("\n"),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const platform = createPlatform({ exec } as any);
    registerGenerateCommand(platform);
    const handler = (platform.registerCommand as any).mock.calls[0][1].handler;

    let selectCount = 0;
    const ctx = createContext({
      ui: {
        notify: mock(),
        select: mock(async (_title: string, options: string[]) => {
          selectCount += 1;
          if (selectCount === 1) {
            expect(options).toEqual([
              "○ packages/pkg-a/README.md",
              "○ packages/pkg-a/docs/setup.md",
              "─── Add manually ───",
              "─── Done ───",
            ]);
            return "○ packages/pkg-a/README.md";
          }

          return "─── Done ───";
        }),
        input: mock(),
        confirm: mock(),
      },
    });

    await handler("docs --target pkg-a", ctx);

    const targets = discoverWorkspaceTargets(tmpDir, detectPackageManager(tmpDir));
    const pkgATarget = targets.find((target) => target.name === "pkg-a");
    expect(pkgATarget).toBeDefined();

    const state = loadState(platform.paths, tmpDir, {
      target: pkgATarget!,
      allTargets: targets,
    });
    expect(state.trackedFiles).toEqual(["packages/pkg-a/README.md"]);
    expect(fs.existsSync(statePath(platform.paths, tmpDir, pkgATarget!))).toBe(true);
    expect(fs.existsSync(statePath(platform.paths, tmpDir))).toBe(false);
    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: expect.stringContaining("Target: pkg-a (packages/pkg-a)") }],
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pkg-a (packages/pkg-a)"),
      "info",
    );
  });

  test("subsequent run with no changes notifies user", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });

    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
        return { code: 0, stdout: "\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const platform = createPlatform({ exec, paths } as any);
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;
    const ctx = createContext();

    await handler("docs", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No changes since last check"),
      "info",
    );
    expect(platform.sendMessage).not.toHaveBeenCalled();
  });

  test("subsequent run with changes sends findings-based steer", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });

    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
        return { code: 0, stdout: "src/app.ts\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "def456\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    // Mock createAgentSession to return drift findings
    const mockSession = {
      prompt: mock(async () => {}),
      state: {
        messages: [
          {
            role: "assistant",
            content: JSON.stringify({
              findings: [{ file: "README.md", description: "Outdated API example", severity: "error", relatedFiles: ["src/app.ts"] }],
              status: "drifted",
            }),
          },
        ],
      },
      dispose: mock(async () => {}),
    };
    const createAgentSession = mock(async () => mockSession);

    const platform = createPlatform({ exec, paths, createAgentSession } as any);
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;

    // Write the tracked doc
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Project docs");

    const ctx = createContext();
    await handler("docs", ctx);

    // Should send steer with finding descriptions
    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-generate-docs",
        content: [{ type: "text", text: expect.stringContaining("Outdated API example") }],
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    // State should be updated
    const state = loadState(paths, tmpDir);
    expect(state.lastCommit).not.toBe("abc123");
  });

  test("requires interactive mode", async () => {
    const platform = createPlatform();
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;
    const ctx = createContext({ hasUI: false });

    await handler("docs", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("interactive mode"),
      "warning",
    );
  });

  test("first run with no files selected does not save state", async () => {
    const exec = mock(async () => ({
      code: 0,
      stdout: "README.md\n",
      stderr: "",
    }));
    const platform = createPlatform({ exec } as any);
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;

    // User immediately clicks Done
    const ctx = createContext({
      ui: {
        notify: mock(),
        select: mock(async () => "─── Done ───"),
        input: mock(),
        confirm: mock(),
      },
    });

    await handler("docs", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No files selected"),
      "info",
    );
    // State file should not exist
    const file = statePath(platform.paths, tmpDir);
    expect(fs.existsSync(file)).toBe(false);
  });
});
