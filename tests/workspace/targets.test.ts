import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverWorkspaceTargets } from "../../src/workspace/targets.js";

let tmpDir: string;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-workspace-targets-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverWorkspaceTargets", () => {
  test("keeps classic root-package behavior in a single-package repo", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "supipowers",
      version: "1.5.3",
    });

    const targets = discoverWorkspaceTargets(tmpDir, "bun");

    expect(targets).toEqual([
      {
        id: "supipowers",
        name: "supipowers",
        kind: "root",
        repoRoot: tmpDir,
        packageDir: tmpDir,
        manifestPath: path.join(tmpDir, "package.json"),
        relativeDir: ".",
        version: "1.5.3",
        private: false,
        packageManager: "bun",
      },
    ]);
  });

  test("discovers package.json workspaces and keeps root first", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*", "apps/*"],
    });
    writeJson(path.join(tmpDir, "packages/pkg-a/package.json"), {
      name: "@repo/pkg-a",
      version: "2.0.0",
    });
    writeJson(path.join(tmpDir, "apps/web/package.json"), {
      name: "@repo/web",
      version: "3.1.0",
    });

    const targets = discoverWorkspaceTargets(tmpDir, "npm");

    expect(targets.map((target) => [target.name, target.kind, target.relativeDir])).toEqual([
      ["repo-root", "root", "."],
      ["@repo/web", "workspace", "apps/web"],
      ["@repo/pkg-a", "workspace", "packages/pkg-a"],
    ]);
  });

  test("discovers pnpm workspaces from pnpm-workspace.yaml", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      private: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - packages/*",
        "  - tooling/**",
        "  - '!tooling/eslint'",
      ].join("\n"),
      "utf-8",
    );
    writeJson(path.join(tmpDir, "packages/pkg-a/package.json"), {
      name: "@repo/pkg-a",
      version: "2.0.0",
    });
    writeJson(path.join(tmpDir, "tooling/cli/package.json"), {
      name: "@repo/cli",
      version: "0.3.0",
    });
    writeJson(path.join(tmpDir, "tooling/eslint/package.json"), {
      name: "@repo/eslint",
      version: "0.1.0",
    });

    const targets = discoverWorkspaceTargets(tmpDir, "pnpm");

    expect(targets.map((target) => target.relativeDir)).toEqual([
      ".",
      "packages/pkg-a",
      "tooling/cli",
    ]);
  });
});
