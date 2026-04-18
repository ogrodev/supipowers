import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverReleaseTargets, getPublishableReleaseTargets } from "../../src/release/targets.js";

let tmpDir: string;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-release-targets-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverReleaseTargets", () => {
  test("keeps classic root-package behavior in a single-package repo", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "supipowers",
      version: "1.5.3",
      files: ["src", "README.md", "src"],
    });

    const targets = discoverReleaseTargets(tmpDir, "bun");

    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      id: "supipowers",
      name: "supipowers",
      kind: "root",
      repoRoot: tmpDir,
      packageDir: tmpDir,
      manifestPath: path.join(tmpDir, "package.json"),
      relativeDir: ".",
      version: "1.5.3",
      private: false,
      publishScopePaths: ["package.json", "src", "README.md"],
      packageManager: "bun",
      defaultTagFormat: "v${version}",
    });
  });

  test("discovers npm/yarn/bun workspaces from package.json workspaces", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*", "apps/*"],
    });
    writeJson(path.join(tmpDir, "packages/pkg-a/package.json"), {
      name: "@repo/pkg-a",
      version: "2.0.0",
      files: ["dist", "README.md"],
    });
    writeJson(path.join(tmpDir, "apps/web/package.json"), {
      name: "@repo/web",
      version: "3.1.0",
    });
    writeJson(path.join(tmpDir, "packages/private/package.json"), {
      name: "@repo/private",
      version: "0.1.0",
      private: true,
    });

    const targets = discoverReleaseTargets(tmpDir, "npm");

    expect(targets.map((target) => [target.name, target.kind, target.relativeDir])).toEqual([
      ["repo-root", "root", "."],
      ["@repo/web", "workspace", "apps/web"],
      ["@repo/pkg-a", "workspace", "packages/pkg-a"],
      ["@repo/private", "workspace", "packages/private"],
    ]);

    const pkgA = targets.find((target) => target.name === "@repo/pkg-a");
    expect(pkgA?.publishScopePaths).toEqual([
      "packages/pkg-a/package.json",
      "packages/pkg-a/dist",
      "packages/pkg-a/README.md",
    ]);
    expect(pkgA?.defaultTagFormat).toBe("@repo/pkg-a@${version}");

    const web = targets.find((target) => target.name === "@repo/web");
    expect(web?.publishScopePaths).toEqual([
      "apps/web/package.json",
      "apps/web",
    ]);
  });

  test("supports the object form of package.json workspaces", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      workspaces: { packages: ["packages/*"] },
    });
    writeJson(path.join(tmpDir, "packages/cli/package.json"), {
      name: "@repo/cli",
      version: "1.2.0",
    });

    const targets = discoverReleaseTargets(tmpDir, "yarn");

    expect(targets.map((target) => target.name)).toEqual(["repo-root", "@repo/cli"]);
    expect(targets[1]?.packageManager).toBe("yarn");
  });

  test("supports pnpm-workspace.yaml discovery", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      private: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "pnpm-workspace.yaml"),
      ["packages:", "  - packages/*", "  - tooling/**"].join("\n"),
      "utf-8",
    );
    writeJson(path.join(tmpDir, "packages/core/package.json"), {
      name: "@repo/core",
      version: "4.0.0",
    });
    writeJson(path.join(tmpDir, "tooling/eslint/config/package.json"), {
      name: "@repo/eslint-config",
      version: "2.0.0",
      files: ["index.js"],
    });

    const targets = discoverReleaseTargets(tmpDir, "pnpm");

    expect(targets.map((target) => target.relativeDir)).toEqual([
      ".",
      "packages/core",
      "tooling/eslint/config",
    ]);
    expect(targets[2]?.publishScopePaths).toEqual([
      "tooling/eslint/config/package.json",
      "tooling/eslint/config/index.js",
    ]);
  });
  test("skips versionless root and workspace manifests from release targets", () => {
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

    const targets = discoverReleaseTargets(tmpDir, "bun");

    expect(targets.map((target) => [target.name, target.relativeDir, target.version])).toEqual([
      ["@repo/pkg-a", "packages/pkg-a", "2.0.0"],
    ]);
  });

});

describe("getPublishableReleaseTargets", () => {
  test("filters private root and workspace packages out of the picker set", () => {
    writeJson(path.join(tmpDir, "package.json"), {
      name: "repo-root",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"],
    });
    writeJson(path.join(tmpDir, "packages/public/package.json"), {
      name: "@repo/public",
      version: "1.0.0",
    });
    writeJson(path.join(tmpDir, "packages/private/package.json"), {
      name: "@repo/private",
      version: "1.0.0",
      private: true,
    });

    const targets = discoverReleaseTargets(tmpDir, "bun");
    const publishable = getPublishableReleaseTargets(targets);

    expect(publishable.map((target) => target.name)).toEqual(["@repo/public"]);
  });
});
