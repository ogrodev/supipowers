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
  test("includes versionless root and workspace manifests for non-release commands", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      private: true,
      workspaces: ["apps/*", "packages/*"],
    });
    writeJson(path.join(tmpDir, "apps/web/package.json"), {
      name: "@repo/web",
      private: true,
    });
    writeJson(path.join(tmpDir, "packages/pkg-a/package.json"), {
      name: "@repo/pkg-a",
      version: "2.0.0",
    });

    const targets = discoverWorkspaceTargets(tmpDir, "bun");

    expect(targets.map((target) => [target.name, target.relativeDir, target.version])).toEqual([
      ["repo-root", ".", "0.0.0"],
      ["@repo/web", "apps/web", "0.0.0"],
      ["@repo/pkg-a", "packages/pkg-a", "2.0.0"],
    ]);
  });


  test("synthesizes a root target for monorepos whose root package.json has no name field", () => {
    // Pure workspace aggregator: has workspaces but no name. Root-level files like
    // bun.lock and .gitignore need a target or they become unaddressable.
    writeJson(path.join(tmpDir, "package.json"), {
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(path.join(tmpDir, "packages/lib/package.json"), {
      name: "lib",
      version: "1.0.0",
    });

    const targets = discoverWorkspaceTargets(tmpDir, "bun");

    const root = targets.find((t) => t.kind === "root");
    expect(root).toBeDefined();
    expect(root!.relativeDir).toBe(".");
    // Name derived from directory basename
    expect(root!.name.length).toBeGreaterThan(0);
    // Workspace package also present
    expect(targets.some((t) => t.name === "lib")).toBe(true);
    // Root sorts first
    expect(targets[0]!.kind).toBe("root");
  });

});
