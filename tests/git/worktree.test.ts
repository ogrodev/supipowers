import { describe, test, expect } from "vitest";
import {
  detectWorktreeDir,
  detectProjectSetup,
  buildWorktreePrompt,
} from "../../src/git/worktree.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("detectWorktreeDir", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-wt-"));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test("returns .worktrees if it exists", () => {
    setup();
    fs.mkdirSync(path.join(tmpDir, ".worktrees"));
    const result = detectWorktreeDir(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".worktrees"));
    cleanup();
  });

  test("returns worktrees if it exists and .worktrees does not", () => {
    setup();
    fs.mkdirSync(path.join(tmpDir, "worktrees"));
    const result = detectWorktreeDir(tmpDir);
    expect(result).toBe(path.join(tmpDir, "worktrees"));
    cleanup();
  });

  test("prefers .worktrees over worktrees when both exist", () => {
    setup();
    fs.mkdirSync(path.join(tmpDir, ".worktrees"));
    fs.mkdirSync(path.join(tmpDir, "worktrees"));
    const result = detectWorktreeDir(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".worktrees"));
    cleanup();
  });

  test("returns null if neither exists", () => {
    setup();
    const result = detectWorktreeDir(tmpDir);
    expect(result).toBeNull();
    cleanup();
  });
});

describe("detectProjectSetup", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-setup-"));
    return tmpDir;
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test("detects Node.js project", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("node");
    expect(result.installCommand).toBe("npm install");
    cleanup();
  });

  test("detects Rust project", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("rust");
    expect(result.installCommand).toBe("cargo build");
    cleanup();
  });

  test("detects Python project with requirements.txt", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("python");
    expect(result.installCommand).toContain("pip install");
    cleanup();
  });

  test("detects Python project with pyproject.toml", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("python");
    cleanup();
  });

  test("detects Go project", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("go");
    expect(result.installCommand).toBe("go mod download");
    cleanup();
  });

  test("returns unknown for unrecognized project", () => {
    setup();
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("unknown");
    expect(result.installCommand).toBeNull();
    cleanup();
  });

  test("detects Bun project with bun.lock", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("node");
    expect(result.installCommand).toBe("bun install");
    cleanup();
  });

  test("detects Bun project with bun.lockb", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.type).toBe("node");
    expect(result.installCommand).toBe("bun install");
    cleanup();
  });

  test("prefers Bun over npm when both bun.lock and package.json exist", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    const result = detectProjectSetup(tmpDir);
    expect(result.installCommand).toBe("bun install");
    cleanup();
  });

  test("prefers pyproject.toml over requirements.txt when both exist", () => {
    setup();
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "");
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "");
    const result = detectProjectSetup(tmpDir);
    expect(result.installCommand).toBe("poetry install");
    cleanup();
  });
});

describe("buildWorktreePrompt", () => {
  test("throws on unsafe branch name", () => {
    expect(() => buildWorktreePrompt({ branchName: "main; rm -rf /", cwd: "/project" })).toThrow("Unsafe branchName");
  });

  test("includes bun install in prompt table", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain("bun install");
  });

  test("includes branch name", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain("feature/auth");
  });

  test("includes directory selection priority", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain(".worktrees");
    expect(prompt).toContain("worktrees");
  });

  test("includes gitignore verification", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain("gitignore");
    expect(prompt).toContain("git check-ignore");
  });

  test("includes project setup detection", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain("npm install");
    expect(prompt).toContain("cargo build");
  });

  test("includes baseline test verification", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain("baseline");
    expect(prompt).toContain("test");
  });

  test("includes worktree creation command", () => {
    const prompt = buildWorktreePrompt({ branchName: "feature/auth", cwd: "/project" });
    expect(prompt).toContain("git worktree add");
  });
});
