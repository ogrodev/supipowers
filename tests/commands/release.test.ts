import { describe, expect, mock, test } from "bun:test";
import {
  buildReleaseTargetOptionLabel,
  buildSelectableReleaseChannelOptions,
  createReleaseProgressKeys,
  findInvalidReleaseChannels,
  isGitHubPermissionDeniedError,
  isInProgressRelease,
  isReleaseTargetLocked,
  maybeSwitchGithubAccountForReleaseFailure,
  parseGithubAuthStatusAccounts,
  parseReleaseArgs,
  RELEASE_STEPS,
  releaseReleaseTargetLock,
  resolveRequestedReleaseTarget,
  selectReleaseTarget,
  sortReleaseTargetOptions,
  tryAcquireReleaseTargetLock,
  type ReleaseTargetOption,
} from "../../src/commands/release.js";
import type { ChannelStatus } from "../../src/release/channels/types.js";
import type { ReleaseTarget } from "../../src/types.js";

describe("isInProgressRelease", () => {
  test("unreleased version + pre-configured channels → resume (skip confirmation)", () => {
    expect(
      isInProgressRelease({ skipBump: true, channelsWerePreConfigured: true, isDryRun: false }),
    ).toBe(true);
  });

  test("unreleased version + channels not yet configured → ask (user needs to pick channels)", () => {
    expect(
      isInProgressRelease({ skipBump: true, channelsWerePreConfigured: false, isDryRun: false }),
    ).toBe(false);
  });

  test("version already released → ask for bump (fresh release flow)", () => {
    expect(
      isInProgressRelease({ skipBump: false, channelsWerePreConfigured: true, isDryRun: false }),
    ).toBe(false);
  });

  test("version already released + no channels → ask", () => {
    expect(
      isInProgressRelease({ skipBump: false, channelsWerePreConfigured: false, isDryRun: false }),
    ).toBe(false);
  });

  test("dry-run always shows confirmation even when resuming", () => {
    expect(
      isInProgressRelease({ skipBump: true, channelsWerePreConfigured: true, isDryRun: true }),
    ).toBe(false);
  });

  test("local-only tag (push failed) + pre-configured channels → resume", () => {
    expect(
      isInProgressRelease({ skipBump: true, channelsWerePreConfigured: true, isDryRun: false }),
    ).toBe(true);
  });
});

describe("release workflow ordering", () => {
  test("runs pre-release gates in the intended order", () => {
    expect(RELEASE_STEPS.slice(0, 3).map((step) => step.key)).toEqual([
      "checks",
      "doc-drift",
      "working-tree",
    ]);
  });
});

function target(name: string, relativeDir = "."): ReleaseTarget {
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
    publishScopePaths: relativeDir === "." ? ["package.json", "."] : [`${relativeDir}/package.json`, relativeDir],
    packageManager: "bun",
    defaultTagFormat: relativeDir === "." ? "v${version}" : `${name}@\${version}`,
  };
}

describe("release target selection", () => {
  test("parses --raw, --dry-run, and --target flags", () => {
    expect(parseReleaseArgs("--raw --dry-run --target @repo/pkg")).toEqual({
      skipPolish: true,
      isDryRun: true,
      requestedTarget: "@repo/pkg",
    });
    expect(parseReleaseArgs("--target=@repo/cli")).toEqual({
      skipPolish: false,
      isDryRun: false,
      requestedTarget: "@repo/cli",
    });
  });

  test("resolves an explicit --target by package name", () => {
    const targets = [target("root"), target("@repo/pkg", "packages/pkg")];
    expect(resolveRequestedReleaseTarget(targets, "@repo/pkg")?.relativeDir).toBe("packages/pkg");
  });

  test("orders changed packages before unchanged packages", () => {
    const options: ReleaseTargetOption[] = [
      { target: target("@repo/unchanged", "packages/unchanged"), changed: false, lastTag: "@repo/unchanged@1.0.0", summary: "no changes found" },
      { target: target("@repo/changed", "packages/changed"), changed: true, lastTag: "@repo/changed@1.0.0", summary: "2 fixes" },
      { target: target("@repo/another-changed", "packages/another"), changed: true, lastTag: null, summary: "1 feature" },
    ];

    expect(sortReleaseTargetOptions(options).map((option) => option.target.name)).toEqual([
      "@repo/another-changed",
      "@repo/changed",
      "@repo/unchanged",
    ]);
  });

  test("formats target picker labels with name, path, release tag, and change state", () => {
    expect(
      buildReleaseTargetOptionLabel({
        target: target("@repo/pkg", "packages/pkg"),
        changed: true,
        lastTag: "@repo/pkg@1.0.0",
        summary: "1 feature, 2 fixes",
      }),
    ).toBe("@repo/pkg — packages/pkg — @repo/pkg@1.0.0 — changed — 1 feature, 2 fixes");
  });

  test("skips the picker for classic repos with a single publishable target", async () => {
    const ctx = {
      ui: { select: mock(async () => null) },
    } as any;

    const selected = await selectReleaseTarget(
      ctx,
      [{ target: target("root"), changed: false, lastTag: null, summary: "change analysis pending" }],
      null,
    );

    expect(selected?.name).toBe("root");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  test("bypasses the picker when --target is provided", async () => {
    const ctx = {
      ui: { select: mock(async () => { throw new Error("picker should be bypassed"); }) },
    } as any;

    const selected = await selectReleaseTarget(
      ctx,
      [
        { target: target("root"), changed: false, lastTag: null, summary: "change analysis pending" },
        { target: target("@repo/pkg", "packages/pkg"), changed: true, lastTag: null, summary: "1 fix" },
      ],
      "@repo/pkg",
    );

    expect(selected?.relativeDir).toBe("packages/pkg");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  test("creates run-specific progress keys so concurrent releases do not collide", () => {
    expect(createReleaseProgressKeys("run-1")).toEqual({
      statusKey: "supi-release:run-1",
      widgetKey: "supi-release:run-1",
    });
  });
});

describe("release target locks", () => {
  test("rejects concurrent releases for the same target until the lock is released", () => {
    releaseReleaseTargetLock("@repo/pkg");
    expect(tryAcquireReleaseTargetLock("@repo/pkg")).toBe(true);
    expect(isReleaseTargetLocked("@repo/pkg")).toBe(true);
    expect(tryAcquireReleaseTargetLock("@repo/pkg")).toBe(false);

    releaseReleaseTargetLock("@repo/pkg");
    expect(isReleaseTargetLocked("@repo/pkg")).toBe(false);
    expect(tryAcquireReleaseTargetLock("@repo/pkg")).toBe(true);

    releaseReleaseTargetLock("@repo/pkg");
  });
});


describe("github auth recovery", () => {
  const GH_STATUS = [
    "github.com",
    "  ✓ Logged in to github.com account ogrodev (keyring)",
    "  - Active account: true",
    "  - Git operations protocol: ssh",
    "",
    "  ✓ Logged in to github.com account PedroMendes-AE (keyring)",
    "  - Active account: false",
    "  - Git operations protocol: ssh",
  ].join("\n");

  test("detects GitHub permission-denied push failures", () => {
    expect(
      isGitHubPermissionDeniedError(
        "git push: remote: Permission to ogrodev/supipowers.git denied to PedroMendes-AE. fatal: unable to access 'https://github.com/ogrodev/supipowers.git/': The requested URL returned error: 403",
      ),
    ).toBe(true);
    expect(isGitHubPermissionDeniedError("git push: rejected non-fast-forward")).toBe(false);
  });

  test("parses multiple GitHub accounts from gh auth status", () => {
    expect(parseGithubAuthStatusAccounts(GH_STATUS)).toEqual([
      { host: "github.com", user: "ogrodev", active: true },
      { host: "github.com", user: "PedroMendes-AE", active: false },
    ]);
  });

  test("prompts for an alternate account and switches before retry", async () => {
    const exec = mock(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") {
        return { stdout: GH_STATUS, stderr: "", code: 0 };
      }
      if (cmd === "gh" && args[0] === "auth" && args[1] === "switch") {
        return { stdout: "", stderr: "", code: 0 };
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    });
    const ctx = {
      cwd: "/repo",
      ui: {
        select: mock(async () => "ogrodev — current"),
        notify: mock(),
      },
    } as any;

    const switchedTo = await maybeSwitchGithubAccountForReleaseFailure(
      { exec } as any,
      ctx,
      "git push: remote: Permission to ogrodev/supipowers.git denied to PedroMendes-AE. fatal: unable to access 'https://github.com/ogrodev/supipowers.git/': The requested URL returned error: 403",
    );

    expect(switchedTo).toBe("ogrodev");
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("gh", ["auth", "status", "--hostname", "github.com"], { cwd: "/repo" });
    expect(exec).toHaveBeenCalledWith(
      "gh",
      ["auth", "switch", "--hostname", "github.com", "--user", "ogrodev"],
      { cwd: "/repo" },
    );
  });
});


describe("release channel validation", () => {
  const detected: ChannelStatus[] = [
    { channel: "github", available: true, detail: "Authenticated with GitHub CLI" },
    { channel: "gitlab", available: false, detail: "GitLab CLI not authenticated" },
    { channel: "npm", available: true, detail: "Custom detect command succeeded" },
  ];

  test("accepts configured channels that are known and available", () => {
    expect(findInvalidReleaseChannels(["github", "npm"], detected)).toEqual([]);
  });

  test("reports unavailable configured channels before release side effects", () => {
    expect(findInvalidReleaseChannels(["gitlab"], detected)).toEqual([
      "gitlab: unavailable (GitLab CLI not authenticated)",
    ]);
  });

  test("reports unknown configured channels before release side effects", () => {
    expect(findInvalidReleaseChannels(["missing-channel"], detected)).toEqual([
      "missing-channel: unknown channel",
    ]);
  });

  test("only offers available channels for interactive selection", () => {
    expect(buildSelectableReleaseChannelOptions(detected)).toEqual([
      "github — Authenticated with GitHub CLI",
      "npm — Custom detect command succeeded",
    ]);
  });
});
