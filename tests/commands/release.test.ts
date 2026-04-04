import { describe, expect, test } from "bun:test";
import { isInProgressRelease } from "../../src/commands/release.js";

// ---------------------------------------------------------------------------
// isInProgressRelease — guards the confirmation bypass in handleRelease
// ---------------------------------------------------------------------------
// The rule: when the version in package.json hasn't been git-tagged yet AND
// channels are already configured in config, re-running supi:release should
// skip the "Ship v{version}?" dialog and proceed directly to execution.
// The user made all decisions when they bumped the version — no new input needed.

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
});
