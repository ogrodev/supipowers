import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform, PlatformPaths } from "../../src/platform/types.js";
import type { DocDriftState } from "../../src/types.js";
import { registerGenerateCommand } from "../../src/commands/generate.js";
import {
  buildFirstRunPrompt,
  buildSubsequentRunPrompt,
  discoverDocFiles,
  loadState,
  saveState,
  statePath,
} from "../../src/docs/drift.js";

// ── Fixtures ──────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-gen-test-"));
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

// ── Prompt builders ───────────────────────────────────────────

describe("buildFirstRunPrompt", () => {
  test("includes drift instructions and doc contents", () => {
    const docs = new Map([
      ["README.md", "# My Project\nSome description"],
      ["docs/api.md", "## API Reference"],
    ]);
    const prompt = buildFirstRunPrompt(docs);
    expect(prompt).toContain("Only flag factual inaccuracies");
    expect(prompt).toContain("missing documentation");
    expect(prompt).toContain("no diffs");
    expect(prompt).toContain("### README.md");
    expect(prompt).toContain("# My Project");
    expect(prompt).toContain("### docs/api.md");
    expect(prompt).toContain("## API Reference");
    expect(prompt).toContain("have drifted from the current codebase");
  });

  test("handles deleted files", () => {
    const docs = new Map([["gone.md", "[FILE DELETED]"]]);
    const prompt = buildFirstRunPrompt(docs);
    expect(prompt).toContain("[FILE DELETED]");
  });
});

describe("buildSubsequentRunPrompt", () => {
  test("includes diff and doc contents", () => {
    const diff = "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new";
    const docs = new Map([["README.md", "description"]]);
    const prompt = buildSubsequentRunPrompt(diff, docs);
    expect(prompt).toContain("```diff");
    expect(prompt).toContain(diff);
    expect(prompt).toContain("### README.md");
    expect(prompt).toContain("description");
    expect(prompt).toContain("determine if any tracked documentation needs updating");
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
  test("first run: discovers files, shows select, saves state, sends steer", async () => {
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "ls-files") {
        return { code: 0, stdout: "README.md\ndocs/setup.md\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "deadbeef\n", stderr: "" };
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

    // Write README.md so readTrackedDocs can read it
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Hello");

    await handler("docs", ctx);

    // State should be saved
    const state = loadState(platform.paths, tmpDir);
    expect(state.trackedFiles).toEqual(["README.md"]);
    expect(state.lastCommit).toBe("deadbeef");
    expect(state.lastRunAt).not.toBeNull();

    // Should have sent steer message
    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-generate-docs",
        content: [{ type: "text", text: expect.stringContaining("# Hello") }],
      }),
      { deliverAs: "steer", triggerTurn: true },
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

  test("subsequent run with changes sends diff-based steer", async () => {
    const paths = createPaths();
    saveState(paths, tmpDir, {
      trackedFiles: ["README.md"],
      lastCommit: "abc123",
      lastRunAt: "2026-04-01T00:00:00Z",
    });

    const diffContent = "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new";
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "diff" && args[1] === "--name-only") {
        return { code: 0, stdout: "src/app.ts\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "diff" && args[1] === "abc123..HEAD") {
        return { code: 0, stdout: diffContent, stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "def456\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const platform = createPlatform({ exec, paths } as any);
    registerGenerateCommand(platform);
    const call = (platform.registerCommand as any).mock.calls[0];
    const handler = call[1].handler;

    // Write the tracked doc
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# Project docs");

    const ctx = createContext();
    await handler("docs", ctx);

    // Should send steer with diff
    expect(platform.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "supi-generate-docs",
        content: [{ type: "text", text: expect.stringContaining(diffContent) }],
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    // State should be updated
    const state = loadState(paths, tmpDir);
    expect(state.lastCommit).toBe("def456");
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
