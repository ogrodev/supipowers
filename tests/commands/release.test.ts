import { describe, expect, test } from "bun:test";
import { isInProgressRelease } from "../../src/commands/release.js";

// ---------------------------------------------------------------------------
// isInProgressRelease — guards the confirmation bypass in handleRelease
// The rule: when the version should not be bumped (skipBump=true) AND
// channels are already configured in config, re-running supi:release should
// skip the "Ship v{version}?" dialog and proceed directly to execution.
// skipBump=true covers two cases:
//   1. No tag at all — version in package.json is unreleased
//   2. Tag exists locally but not on remote — incomplete release (push failed)

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
    // skipBump=false means currentVersion already has a git tag; user must pick a new version
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
    // --dry-run is exploratory; user explicitly wants to preview and confirm
    expect(
      isInProgressRelease({ skipBump: true, channelsWerePreConfigured: true, isDryRun: true }),
    ).toBe(false);
  });

  test("local-only tag (push failed) + pre-configured channels → resume", () => {
    // Tag was created locally but push failed — the release command sets
    // skipBump=true AND skipTag=true, so isInProgressRelease triggers resume
    expect(
      isInProgressRelease({ skipBump: true, channelsWerePreConfigured: true, isDryRun: false }),
    ).toBe(true);
  });
});
