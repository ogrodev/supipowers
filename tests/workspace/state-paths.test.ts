import { describe, expect, test } from "bun:test";
import { createPaths } from "../../src/platform/types.js";
import {
  getRootConfigPath,
  getRootStateDir,
  getTargetStateDir,
  getTargetStatePath,
  getWorkspaceConfigPath,
  getWorkspaceStateDir,
} from "../../src/workspace/state-paths.js";
import type { WorkspaceTarget } from "../../src/types.js";

const paths = createPaths(".omp");

function target(name: string, relativeDir = "."): WorkspaceTarget {
  return {
    id: name,
    name,
    kind: relativeDir === "." ? "root" : "workspace",
    repoRoot: "/repo",
    packageDir: relativeDir === "." ? "/repo" : `/repo/${relativeDir}`,
    manifestPath: relativeDir === "." ? "/repo/package.json" : `/repo/${relativeDir}/package.json`,
    relativeDir,
    version: "1.0.0",
    private: false,
    packageManager: "bun",
  };
}

describe("workspace state paths", () => {
  test("keeps root state at the existing project path", () => {
    expect(getRootStateDir(paths, "/repo")).toBe("/repo/.omp/supipowers");
    expect(getRootConfigPath(paths, "/repo")).toBe("/repo/.omp/supipowers/config.json");
    expect(getTargetStateDir(paths, target("repo-root"))).toBe("/repo/.omp/supipowers");
  });

  test("namespaces workspace state under the repo root .omp tree", () => {
    expect(getWorkspaceStateDir(paths, "/repo", "packages/pkg-a")).toBe(
      "/repo/.omp/supipowers/workspaces/packages/pkg-a",
    );
    expect(getWorkspaceConfigPath(paths, "/repo", "packages/pkg-a")).toBe(
      "/repo/.omp/supipowers/workspaces/packages/pkg-a/config.json",
    );
    expect(getTargetStatePath(paths, target("@repo/pkg-a", "packages/pkg-a"), "reviews", "session.json")).toBe(
      "/repo/.omp/supipowers/workspaces/packages/pkg-a/reviews/session.json",
    );
  });
});
