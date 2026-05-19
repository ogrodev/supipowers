import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createPaths } from "../../src/platform/types.js";
import {
  getHarnessDocsStagingLayerPath,
  getHarnessMarkerPath,
  getHarnessProjectRoot,
  getHarnessQueuePath,
  getHarnessRepoDocsLayerPath,
  getHarnessRepoLocalDir,
  getHarnessSessionDir,
} from "../../src/harness/project-paths.js";
import { getLocalTargetStatePath } from "../../src/workspace/state-paths.js";
import type { WorkspaceTarget } from "../../src/types.js";
import { createHermeticPaths, slugForCwd } from "../helpers/paths.js";

let tmpDir: string;
let repoRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-cross-platform-paths-"));
  repoRoot = path.join(tmpDir, "Repo With Spaces (δ)");
  fs.mkdirSync(path.join(repoRoot, "packages", "pkg-a"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "root" }), "utf8");
  fs.writeFileSync(
    path.join(repoRoot, "packages", "pkg-a", "package.json"),
    JSON.stringify({ name: "pkg-a" }),
    "utf8",
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function workspaceTarget(relativeDir: string): WorkspaceTarget {
  return {
    id: "pkg-a",
    name: "pkg-a",
    kind: "workspace",
    repoRoot,
    packageDir: path.join(repoRoot, ...relativeDir.split("/")),
    manifestPath: path.join(repoRoot, ...relativeDir.split("/"), "package.json"),
    relativeDir,
    version: "1.0.0",
    private: false,
    packageManager: "bun",
  };
}

describe("PlatformPaths", () => {
  test("builds project, global, and agent paths with the host path implementation", () => {
    const paths = createPaths(".omp");

    expect(paths.project(repoRoot, "plans", "draft.md")).toBe(
      path.join(repoRoot, ".omp", "supipowers", "plans", "draft.md"),
    );
    expect(paths.global("config.json")).toBe(
      path.join(os.homedir(), ".omp", "supipowers", "config.json"),
    );
    expect(paths.agent("extensions", "supipowers")).toBe(
      path.join(os.homedir(), ".omp", "agent", "extensions", "supipowers"),
    );
  });
});

describe("harness path helpers", () => {
  test("separates global per-project state from repo-local marker state", () => {
    const paths = createHermeticPaths(tmpDir);
    const slug = slugForCwd(repoRoot);

    expect(getHarnessProjectRoot(paths, repoRoot)).toBe(
      path.join(tmpDir, "home", ".omp", "supipowers", "projects", slug, "harness"),
    );
    expect(getHarnessQueuePath(paths, repoRoot)).toBe(
      path.join(tmpDir, "home", ".omp", "supipowers", "projects", slug, "harness", "queue.jsonl"),
    );
    expect(getHarnessSessionDir(paths, repoRoot, "session-1")).toBe(
      path.join(
        tmpDir,
        "home",
        ".omp",
        "supipowers",
        "projects",
        slug,
        "harness",
        "sessions",
        "session-1",
      ),
    );
    expect(getHarnessRepoLocalDir(paths, repoRoot)).toBe(
      path.join(repoRoot, ".omp", "supipowers", "harness"),
    );
    expect(getHarnessMarkerPath(paths, repoRoot)).toBe(
      path.join(repoRoot, ".omp", "supipowers", "harness", "marker.json"),
    );
  });

  test("keeps generated layer docs inside staging or repo docs directories", () => {
    const paths = createHermeticPaths(tmpDir);

    expect(getHarnessDocsStagingLayerPath(paths, repoRoot, "session-1", "app_core")).toBe(
      path.join(getHarnessSessionDir(paths, repoRoot, "session-1"), "docs", "layers", "app_core.md"),
    );
    expect(getHarnessRepoDocsLayerPath(paths, repoRoot, "app_core")).toBe(
      path.join(repoRoot, "docs", "layers", "app_core.md"),
    );
    expect(() => getHarnessRepoDocsLayerPath(paths, repoRoot, "..\\escape")).toThrow(
      /invalid layer id/,
    );
    expect(() => getHarnessRepoDocsLayerPath(paths, repoRoot, "../escape")).toThrow(
      /invalid layer id/,
    );
  });
});

describe("workspace state paths", () => {
  test("normalizes Windows-style workspace relative paths before joining segments", () => {
    const paths = createHermeticPaths(tmpDir);
    const target = workspaceTarget("packages\\pkg-a");

    expect(getLocalTargetStatePath(paths, target, "reviews", "session.json")).toBe(
      path.join(
        repoRoot,
        ".omp",
        "supipowers",
        "workspaces",
        "packages",
        "pkg-a",
        "reviews",
        "session.json",
      ),
    );
  });
});
