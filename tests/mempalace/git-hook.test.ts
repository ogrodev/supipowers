import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import {
  getMempalacePostCommitHookStatus,
  installMempalacePostCommitHook,
  MEM_PALACE_POST_COMMIT_HOOK_MARKER,
  uninstallMempalacePostCommitHook,
  toHookShellPath,
} from "../../src/mempalace/git-hook.js";
import type { MempalaceInstallSnapshot } from "../../src/mempalace/installer-helper.js";
import type { Platform, PlatformPaths } from "../../src/platform/types.js";

function isolatedPaths(rootDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(rootDir, "global", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(rootDir, "agent", ...segments),
  };
}

function readySnapshot(rootDir: string): MempalaceInstallSnapshot {
  return {
    enabled: true,
    packageVersion: "test",
    managedBinDir: path.join(rootDir, "global", ".omp", "supipowers", "bin"),
    uvPath: path.join(rootDir, "global", ".omp", "supipowers", "bin", process.platform === "win32" ? "uv.exe" : "uv"),
    uvInstalled: true,
    venvPath: path.join(rootDir, "venv"),
    venvPython: process.platform === "win32"
      ? path.join(rootDir, "venv", "Scripts", "python.exe")
      : path.join(rootDir, "venv", "bin", "python"),
    venvInstalled: true,
    bridgeOk: true,
    bridgePath: path.join(rootDir, "bridge.py"),
    ready: true,
  };
}

function gitExec(repoRoot: string, coreHooksPath: string | null = null): Platform["exec"] {
  return mock(async (_cmd: string, args: string[]) => {
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") {
      return { code: 0, stdout: `${repoRoot}\n`, stderr: "" };
    }
    if (key === "rev-parse --git-common-dir") {
      return { code: 0, stdout: ".git\n", stderr: "" };
    }
    if (key === "config --get core.hooksPath") {
      return coreHooksPath === null
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: `${coreHooksPath}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected git args: ${key}` };
  }) as Platform["exec"];
}


function chmodExecutable(filePath: string): void {
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o755);
}
describe("MemPalace post-commit git hook", () => {
  let tmpDir: string;
  let repoDir: string;
  let paths: PlatformPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-mempalace-git-hook-"));
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "fixture" }));
    paths = isolatedPaths(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("renders Windows paths in a Git-shell friendly form", () => {
    expect(toHookShellPath(String.raw`C:\Users\Ada\mempalace\Scripts\python.exe`, "win32")).toBe(
      "C:/Users/Ada/mempalace/Scripts/python.exe",
    );
    expect(toHookShellPath("/Users/ada/mempalace/bin/python", "darwin")).toBe("/Users/ada/mempalace/bin/python");
  });

  test("installs the managed post-commit hook and runner idempotently", async () => {
    const snapshot = readySnapshot(tmpDir);
    const first = await installMempalacePostCommitHook({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir),
      snapshot,
    });

    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.action).toBe("installed");
    expect(first.managed).toBe(true);
    expect(first.runnerPresent).toBe(true);

    const hookText = fs.readFileSync(first.hookPath, "utf-8");
    expect(hookText).toContain(MEM_PALACE_POST_COMMIT_HOOK_MARKER);
    expect(hookText).toContain("post-commit.user");
    expect(hookText).toContain("supi-mempalace-reindex.py");
    expect(hookText).toContain("[ -f \"$PYTHON\" ]");
    expect(hookText).toContain("sh \"$USER_HOOK\" \"$@\"");
    expect(fs.readFileSync(first.runnerPath, "utf-8")).toContain("supipowers-mempalace-reindex-runner v1");

    const second = await installMempalacePostCommitHook({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir),
      snapshot,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.message);
    expect(second.action).toBe("already-installed");
    expect(fs.readFileSync(second.hookPath, "utf-8")).toBe(hookText);
  });

  test("chains a pre-existing user hook and restores it on uninstall", async () => {
    const hookPath = path.join(repoDir, ".git", "hooks", "post-commit");
    const userHook = "#!/bin/sh\necho user-hook\n";
    fs.writeFileSync(hookPath, userHook);
    chmodExecutable(hookPath);

    const install = await installMempalacePostCommitHook({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir),
      snapshot: readySnapshot(tmpDir),
    });

    expect(install.ok).toBe(true);
    if (!install.ok) throw new Error(install.message);
    expect(install.action).toBe("chained-user-hook");
    expect(fs.readFileSync(path.join(repoDir, ".git", "hooks", "post-commit.user"), "utf-8")).toBe(userHook);
    expect(fs.readFileSync(hookPath, "utf-8")).toContain(MEM_PALACE_POST_COMMIT_HOOK_MARKER);

    const uninstall = await uninstallMempalacePostCommitHook({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir),
    });

    expect(uninstall.ok).toBe(true);
    if (!uninstall.ok) throw new Error(uninstall.message);
    expect(uninstall.action).toBe("restored-user-hook");
    expect(fs.readFileSync(hookPath, "utf-8")).toBe(userHook);
    expect(fs.existsSync(path.join(repoDir, ".git", "hooks", "post-commit.user"))).toBe(false);
  });

  test("refuses to overwrite a non-managed hook when the chained user slot already exists", async () => {
    const hooksDir = path.join(repoDir, ".git", "hooks");
    fs.writeFileSync(path.join(hooksDir, "post-commit"), "#!/bin/sh\necho active\n");
    fs.writeFileSync(path.join(hooksDir, "post-commit.user"), "#!/bin/sh\necho backup\n");

    const result = await installMempalacePostCommitHook({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir),
      snapshot: readySnapshot(tmpDir),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected conflict");
    expect(result.code).toBe("user_hook_conflict");
    expect(fs.readFileSync(path.join(hooksDir, "post-commit"), "utf-8")).toContain("active");
  });

  test("respects a configured core.hooksPath", async () => {
    fs.mkdirSync(path.join(repoDir, "hooks"), { recursive: true });

    const status = await getMempalacePostCommitHookStatus({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir, "hooks"),
    });

    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.message);
    expect(status.hooksDir).toBe(path.join(repoDir, "hooks"));
    expect(status.coreHooksPath).toBe("hooks");
  });

  test("does not install when the managed MemPalace runtime is not ready", async () => {
    const snapshot = { ...readySnapshot(tmpDir), ready: false, venvInstalled: false };
    const result = await installMempalacePostCommitHook({
      paths,
      cwd: repoDir,
      config: DEFAULT_CONFIG,
      exec: gitExec(repoDir),
      snapshot,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not-ready result");
    expect(result.code).toBe("mempalace_not_ready");
    expect(fs.existsSync(path.join(repoDir, ".git", "hooks", "post-commit"))).toBe(false);
  });
});
