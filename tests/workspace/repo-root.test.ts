import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRepoRoot, resolveRepoRootFromFs } from "../../src/workspace/repo-root.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-repo-root-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveRepoRootFromFs", () => {
  test("walks from a workspace package back to the workspace root", () => {
    const repoRoot = path.join(tmpDir, "repo");
    const workspaceDir = path.join(repoRoot, "packages", "app");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "repo", version: "1.0.0", workspaces: ["packages/*"] }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspaceDir, "package.json"),
      JSON.stringify({ name: "app", version: "1.0.0" }, null, 2),
      "utf-8",
    );

    expect(resolveRepoRootFromFs(workspaceDir)).toBe(repoRoot);
  });

  test("falls back to the nearest package root when no workspace manifest exists", () => {
    const packageDir = path.join(tmpDir, "single-app");
    const nestedDir = path.join(packageDir, "src", "lib");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "single-app", version: "1.0.0" }, null, 2),
      "utf-8",
    );

    expect(resolveRepoRootFromFs(nestedDir)).toBe(packageDir);
  });
});

describe("resolveRepoRoot", () => {
  test("prefers git rev-parse output when available", async () => {
    const exec = mock(async () => ({ code: 0, stdout: "/repo\n", stderr: "" }));

    const repoRoot = await resolveRepoRoot({ exec } as any, "/repo/packages/app");

    expect(repoRoot).toBe("/repo");
    expect(exec).toHaveBeenCalledWith("git", ["rev-parse", "--show-toplevel"], { cwd: "/repo/packages/app" });
  });
});
