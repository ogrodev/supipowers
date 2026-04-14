import { describe, expect, test } from "bun:test";
import {
  buildSelectableReleaseChannelOptions,
  findInvalidReleaseChannels,
  isInProgressRelease,
  RELEASE_STEPS,
} from "../../src/commands/release.js";
import type { ChannelStatus } from "../../src/release/channels/types.js";

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
