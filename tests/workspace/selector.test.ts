import { describe, expect, mock, test } from "bun:test";
import {
  buildWorkspaceTargetOptionLabel,
  parseTargetArg,
  resolveRequestedWorkspaceTarget,
  selectWorkspaceTarget,
  sortWorkspaceTargetOptions,
  type WorkspaceTargetOption,
} from "../../src/workspace/selector.js";
import {
  isWorkspaceTargetLocked,
  releaseWorkspaceTargetLock,
  tryAcquireWorkspaceTargetLock,
} from "../../src/workspace/locks.js";
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

describe("workspace selector", () => {
  test("parses --target flags", () => {
    expect(parseTargetArg("--raw --target @repo/pkg")).toBe("@repo/pkg");
    expect(parseTargetArg("--target=@repo/cli --dry-run")).toBe("@repo/cli");
    expect(parseTargetArg("--raw")).toBeNull();
  });

  test("resolves explicit targets by id or name", () => {
    const targets = [target("repo-root"), target("@repo/pkg", "packages/pkg")];

    expect(resolveRequestedWorkspaceTarget(targets, "@repo/pkg")?.relativeDir).toBe("packages/pkg");
    expect(resolveRequestedWorkspaceTarget(targets, "repo-root")?.relativeDir).toBe(".");
  });

  test("orders changed targets before unchanged targets", () => {
    const options: WorkspaceTargetOption[] = [
      { target: target("@repo/unchanged", "packages/unchanged"), changed: false },
      { target: target("@repo/changed", "packages/changed"), changed: true },
      { target: target("@repo/another", "packages/another"), changed: true },
    ];

    expect(sortWorkspaceTargetOptions(options).map((option) => option.target.name)).toEqual([
      "@repo/another",
      "@repo/changed",
      "@repo/unchanged",
    ]);
  });

  test("builds default target labels", () => {
    expect(
      buildWorkspaceTargetOptionLabel(
        { target: target("@repo/pkg", "packages/pkg"), changed: true },
        ["changed", "2 fixes"],
      ),
    ).toBe("@repo/pkg — packages/pkg — changed — 2 fixes");
  });

  test("auto-selects the only target", async () => {
    const ctx = {
      ui: { select: mock(async () => null) },
    } as any;

    const selected = await selectWorkspaceTarget(
      ctx,
      [{ target: target("repo-root"), changed: false }],
      null,
      { title: "Pick target" },
    );

    expect(selected?.name).toBe("repo-root");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  test("bypasses the picker when --target is provided", async () => {
    const ctx = {
      ui: { select: mock(async () => { throw new Error("picker should not run"); }) },
    } as any;

    const selected = await selectWorkspaceTarget(
      ctx,
      [
        { target: target("repo-root"), changed: false },
        { target: target("@repo/pkg", "packages/pkg"), changed: true },
      ],
      "@repo/pkg",
      { title: "Pick target" },
    );

    expect(selected?.relativeDir).toBe("packages/pkg");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("workspace target locks", () => {
  test("locks by command name and target id", () => {
    releaseWorkspaceTargetLock("release", "@repo/pkg");
    releaseWorkspaceTargetLock("checks", "@repo/pkg");

    expect(tryAcquireWorkspaceTargetLock("release", "@repo/pkg")).toBe(true);
    expect(isWorkspaceTargetLocked("release", "@repo/pkg")).toBe(true);
    expect(tryAcquireWorkspaceTargetLock("release", "@repo/pkg")).toBe(false);
    expect(tryAcquireWorkspaceTargetLock("checks", "@repo/pkg")).toBe(true);

    releaseWorkspaceTargetLock("release", "@repo/pkg");
    releaseWorkspaceTargetLock("checks", "@repo/pkg");
    expect(isWorkspaceTargetLocked("release", "@repo/pkg")).toBe(false);
  });
});
