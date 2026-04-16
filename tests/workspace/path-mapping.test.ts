import { describe, expect, test } from "bun:test";
import {
  filterPathsForWorkspaceTarget,
  findWorkspaceTargetForPath,
  getChangedWorkspaceTargets,
  partitionPathsByWorkspaceTarget,
} from "../../src/workspace/path-mapping.js";
import { filterGitLogOnelineToWorkspaceTarget } from "../../src/workspace/git-scope.js";
import type { WorkspaceTarget } from "../../src/types.js";

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

const TARGETS = [
  target("repo-root"),
  target("@repo/pkg-a", "packages/pkg-a"),
  target("@repo/pkg-b", "packages/pkg-b"),
];

describe("workspace path mapping", () => {
  test("assigns root-owned files to the root target and package files to the most specific workspace", () => {
    expect(findWorkspaceTargetForPath(TARGETS, "README.md")?.name).toBe("repo-root");
    expect(findWorkspaceTargetForPath(TARGETS, "packages/pkg-a/src/index.ts")?.name).toBe("@repo/pkg-a");
    expect(findWorkspaceTargetForPath(TARGETS, "packages/pkg-b/package.json")?.name).toBe("@repo/pkg-b");
  });

  test("filters repo paths down to a selected target", () => {
    expect(
      filterPathsForWorkspaceTarget(TARGETS, TARGETS[0]!, [
        "README.md",
        "packages/pkg-a/src/index.ts",
        "docs/guide.md",
      ]),
    ).toEqual(["README.md", "docs/guide.md"]);

    expect(
      filterPathsForWorkspaceTarget(TARGETS, TARGETS[1]!, [
        "README.md",
        "packages/pkg-a/src/index.ts",
        "packages/pkg-b/src/index.ts",
      ]),
    ).toEqual(["packages/pkg-a/src/index.ts"]);
  });

  test("partitions changed files and reports changed targets", () => {
    const paths = [
      "README.md",
      "packages/pkg-a/src/index.ts",
      "packages/pkg-b/src/index.ts",
      "packages/pkg-b/test.ts",
    ];

    const partitions = partitionPathsByWorkspaceTarget(TARGETS, paths);
    expect(partitions.get("repo-root")).toEqual(["README.md"]);
    expect(partitions.get("@repo/pkg-a")).toEqual(["packages/pkg-a/src/index.ts"]);
    expect(partitions.get("@repo/pkg-b")).toEqual([
      "packages/pkg-b/src/index.ts",
      "packages/pkg-b/test.ts",
    ]);

    expect(getChangedWorkspaceTargets(TARGETS, paths).map((target) => target.name)).toEqual([
      "repo-root",
      "@repo/pkg-a",
      "@repo/pkg-b",
    ]);
  });
});

describe("workspace git scope helpers", () => {
  test("filters git log records to the selected target", () => {
    const gitLog = [
      "\u001e0123456789abcdef\u001ffeat(root): update readme",
      "README.md",
      "",
      "\u001eabcdef0123456789\u001ffix(pkg-a): guard workspace loader",
      "packages/pkg-a/src/index.ts",
      "packages/pkg-a/test.ts",
      "",
      "\u001e1111111111111111\u001fdocs(pkg-b): add guide",
      "packages/pkg-b/README.md",
      "",
    ].join("\n");

    expect(filterGitLogOnelineToWorkspaceTarget(gitLog, TARGETS, TARGETS[0]!)).toBe(
      "0123456 feat(root): update readme",
    );
    expect(filterGitLogOnelineToWorkspaceTarget(gitLog, TARGETS, TARGETS[1]!)).toBe(
      "abcdef0 fix(pkg-a): guard workspace loader",
    );
  });
});
