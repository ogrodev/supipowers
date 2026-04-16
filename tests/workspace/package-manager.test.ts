import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectPackageManager,
  getRunScriptCommand,
  resolvePackageManager,
} from "../../src/workspace/package-manager.js";

let tmpDir: string;

function writePackageJson(value: unknown): void {
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(value, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-workspace-pm-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
  test("prefers package.json packageManager when present", () => {
    writePackageJson({ name: "repo", packageManager: "pnpm@10.12.1" });
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "", "utf-8");

    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  test("falls back to lockfiles in precedence order", () => {
    writePackageJson({ name: "repo" });
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "", "utf-8");

    expect(detectPackageManager(tmpDir)).toBe("yarn");

    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "", "utf-8");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  test("uses pnpm workspace metadata when no packageManager field or lockfile exists", () => {
    writePackageJson({ name: "repo", version: "1.0.0" });
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf-8");

    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  test("uses package.json workspaces metadata as the final workspace fallback", () => {
    writePackageJson({
      name: "repo",
      version: "1.0.0",
      workspaces: { packages: ["packages/*"] },
    });

    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  test("preserves single-package behavior by defaulting to bun", () => {
    writePackageJson({ name: "repo", version: "1.0.0" });

    expect(detectPackageManager(tmpDir)).toBe("bun");
  });
});

describe("getRunScriptCommand", () => {
  test("returns the expected script invocation for every supported manager", () => {
    expect(getRunScriptCommand("bun", "build")).toEqual({ command: "bun", args: ["run", "build"] });
    expect(getRunScriptCommand("npm", "build")).toEqual({ command: "npm", args: ["run", "build"] });
    expect(getRunScriptCommand("pnpm", "build")).toEqual({ command: "pnpm", args: ["run", "build"] });
    expect(getRunScriptCommand("yarn", "build")).toEqual({ command: "yarn", args: ["build"] });
  });
});

describe("resolvePackageManager", () => {
  test("returns reusable script helpers for the detected package manager", () => {
    writePackageJson({ name: "repo", packageManager: "bun@1.3.10" });

    const resolved = resolvePackageManager(tmpDir);

    expect(resolved.id).toBe("bun");
    expect(resolved.buildCommand).toEqual({ command: "bun", args: ["run", "build"] });
    expect(resolved.runScript("test")).toEqual({ command: "bun", args: ["run", "test"] });
  });
});
