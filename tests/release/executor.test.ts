import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeRelease, isNonFastForwardPushError } from "../../src/release/executor.js";
import type { PackageManagerId, ReleaseTarget } from "../../src/types.js";

let tmpDir: string;

function okExec() {
  return mock().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
}

function failAt(callIndex: number, stderr = "error") {
  const fn = mock();
  fn.mockImplementation(() => {
    const index = fn.mock.calls.length - 1;
    if (index === callIndex) {
      return Promise.resolve({ stdout: "", stderr, code: 1 });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  });
  return fn;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function createTarget(name: string, relativeDir = ".", packageManager: PackageManagerId = "bun"): ReleaseTarget {
  return {
    id: name,
    name,
    kind: relativeDir === "." ? "root" : "workspace",
    repoRoot: tmpDir,
    packageDir: relativeDir === "." ? tmpDir : path.join(tmpDir, relativeDir),
    manifestPath: relativeDir === "." ? path.join(tmpDir, "package.json") : path.join(tmpDir, relativeDir, "package.json"),
    relativeDir,
    version: "1.0.0",
    private: false,
    publishScopePaths: relativeDir === "." ? ["package.json", "src"] : [`${relativeDir}/package.json`, `${relativeDir}/dist`],
    packageManager,
    defaultTagFormat: relativeDir === "." ? "v${version}" : `${name}@\${version}`,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-exec-"));
  writeJson(path.join(tmpDir, "package.json"), { name: "repo-root", version: "1.0.0" });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("executeRelease", () => {
  test("releases a workspace target while building in package cwd and staging only its manifest", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), {
      name: "@repo/pkg",
      version: "1.0.0",
      scripts: { build: "tsc" },
    });
    const target = createTarget("@repo/pkg", "packages/pkg", "npm");
    const exec = okExec();

    const result = await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "2.0.0",
      changelog: "- feat: workspace release",
      channels: ["github"],
      dryRun: false,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(result).toEqual({
      version: "2.0.0",
      tagCreated: true,
      pushed: true,
      channels: [{ channel: "github", success: true }],
    });

    expect(JSON.parse(fs.readFileSync(target.manifestPath, "utf-8"))).toMatchObject({ version: "2.0.0" });
    expect(exec.mock.calls).toEqual([
      ["npm", ["run", "build"], { cwd: target.packageDir }],
      ["git", ["add", "--", "packages/pkg/package.json"], { cwd: tmpDir }],
      ["git", ["commit", "-m", "chore(release): @repo/pkg@2.0.0"], { cwd: tmpDir }],
      ["git", ["pull", "--rebase", "origin"], { cwd: tmpDir }],
      ["git", ["tag", "-a", "@repo/pkg@2.0.0", "-m", "Release @repo/pkg@2.0.0\n\n- feat: workspace release"], { cwd: tmpDir }],
      ["git", ["push", "origin", "HEAD", "--follow-tags"], { cwd: tmpDir }],
      ["gh", ["release", "create", "@repo/pkg@2.0.0", "--title", "@repo/pkg@2.0.0", "--notes", "- feat: workspace release"], { cwd: tmpDir }],
    ]);
  });

  test("uses the root manifest and root-relative staging for classic releases", async () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      scripts: { build: "tsc" },
    });
    const target = createTarget("repo-root", ".", "bun");
    const exec = okExec();

    await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.1.0",
      changelog: "notes",
      channels: [],
      dryRun: false,
      tagFormat: "v${version}",
    });

    expect(exec.mock.calls[0]).toEqual(["bun", ["run", "build"], { cwd: tmpDir }]);
    expect(exec.mock.calls[1]).toEqual(["git", ["add", "--", "package.json"], { cwd: tmpDir }]);
  });

  test("respects non-bun package managers for build execution", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), {
      name: "@repo/pkg",
      version: "1.0.0",
      scripts: { build: "vite build" },
    });
    const target = createTarget("@repo/pkg", "packages/pkg", "yarn");
    const exec = okExec();

    await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.1.0",
      changelog: "",
      channels: [],
      dryRun: false,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(exec.mock.calls[0]).toEqual(["yarn", ["build"], { cwd: target.packageDir }]);
  });

  test("dry-run mode makes no exec calls", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), { name: "@repo/pkg", version: "1.0.0" });
    const exec = okExec();

    const result = await executeRelease({
      exec,
      cwd: tmpDir,
      target: createTarget("@repo/pkg", "packages/pkg"),
      version: "3.0.0",
      changelog: "breaking",
      channels: ["github"],
      dryRun: true,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(exec).not.toHaveBeenCalled();
    expect(result.pushed).toBe(true);
    expect(result.channels).toEqual([{ channel: "github", success: true }]);
  });

  test("skipBump leaves the target manifest untouched and skips add/commit", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), { name: "@repo/pkg", version: "1.0.0" });
    const target = createTarget("@repo/pkg", "packages/pkg");
    const exec = okExec();

    await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.0.0",
      changelog: "notes",
      channels: [],
      dryRun: false,
      skipBump: true,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(JSON.parse(fs.readFileSync(target.manifestPath, "utf-8"))).toMatchObject({ version: "1.0.0" });
    expect(exec.mock.calls).toEqual([
      ["git", ["pull", "--rebase", "origin"], { cwd: tmpDir }],
      ["git", ["tag", "-a", "@repo/pkg@1.0.0", "-m", "Release @repo/pkg@1.0.0\n\nnotes"], { cwd: tmpDir }],
      ["git", ["push", "origin", "HEAD", "--follow-tags"], { cwd: tmpDir }],
    ]);
  });

  test("returns pushed=false and skips channels when push fails", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), { name: "@repo/pkg", version: "1.0.0" });
    const target = createTarget("@repo/pkg", "packages/pkg");
    const exec = failAt(4, "push rejected");

    const result = await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.2.0",
      changelog: "",
      channels: ["github"],
      dryRun: false,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(result).toEqual({
      version: "1.2.0",
      tagCreated: true,
      pushed: false,
      channels: [],
      error: "git push: push rejected",
    });
  });

  test("records channel failures without rolling back git success", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), { name: "@repo/pkg", version: "1.0.0" });
    const target = createTarget("@repo/pkg", "packages/pkg");
    const exec = mock((cmd: string) => {
      if (cmd === "gh") {
        return Promise.resolve({ stdout: "", stderr: "gh error", code: 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.3.0",
      changelog: "notes",
      channels: ["github"],
      dryRun: false,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(result.tagCreated).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.channels).toEqual([{ channel: "github", success: false, error: "gh error" }]);
  });

  test("refreshes the existing tag when skipTag is true", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), { name: "@repo/pkg", version: "1.0.0" });
    const target = createTarget("@repo/pkg", "packages/pkg");
    const exec = okExec();

    await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.0.0",
      changelog: "notes",
      channels: [],
      dryRun: false,
      skipBump: true,
      skipTag: true,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(exec.mock.calls[1]).toEqual([
      "git",
      ["tag", "-a", "-f", "@repo/pkg@1.0.0", "-m", "Release @repo/pkg@1.0.0\n\nnotes"],
      { cwd: tmpDir },
    ]);
  });


describe("push retry helpers", () => {
  test("detects non-fast-forward push failures", () => {
    expect(isNonFastForwardPushError("[rejected] main -> main (non-fast-forward)")).toBe(true);
    expect(isNonFastForwardPushError("Updates were rejected because the remote contains work that you do not have locally. fetch first.")).toBe(true);
    expect(isNonFastForwardPushError("permission denied")).toBe(false);
  });

  test("retries non-fast-forward pushes with rebase and tag refresh before publishing", async () => {
    writeJson(path.join(tmpDir, "packages/pkg/package.json"), { name: "@repo/pkg", version: "1.0.0" });
    const target = createTarget("@repo/pkg", "packages/pkg");
    const exec = mock(() => {
      const callIndex = exec.mock.calls.length - 1;
      if (callIndex === 4) {
        return Promise.resolve({
          stdout: "",
          stderr: "[rejected] main -> main (non-fast-forward)",
          code: 1,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await executeRelease({
      exec,
      cwd: tmpDir,
      target,
      version: "1.4.0",
      changelog: "notes",
      channels: ["github"],
      dryRun: false,
      tagFormat: "@repo/pkg@${version}",
    });

    expect(result.pushed).toBe(true);
    expect(result.channels).toEqual([{ channel: "github", success: true }]);
    expect(exec.mock.calls as unknown[]).toEqual([
      ["git", ["add", "--", "packages/pkg/package.json"], { cwd: tmpDir }],
      ["git", ["commit", "-m", "chore(release): @repo/pkg@1.4.0"], { cwd: tmpDir }],
      ["git", ["pull", "--rebase", "origin"], { cwd: tmpDir }],
      ["git", ["tag", "-a", "@repo/pkg@1.4.0", "-m", "Release @repo/pkg@1.4.0\n\nnotes"], { cwd: tmpDir }],
      ["git", ["push", "origin", "HEAD", "--follow-tags"], { cwd: tmpDir }],
      ["git", ["pull", "--rebase", "origin"], { cwd: tmpDir }],
      ["git", ["tag", "-a", "-f", "@repo/pkg@1.4.0", "-m", "Release @repo/pkg@1.4.0\n\nnotes"], { cwd: tmpDir }],
      ["git", ["push", "origin", "HEAD", "--follow-tags"], { cwd: tmpDir }],
      ["gh", ["release", "create", "@repo/pkg@1.4.0", "--title", "@repo/pkg@1.4.0", "--notes", "notes"], { cwd: tmpDir }],
    ]);
  });
});
});
