import { describe, expect, test } from "vitest";
import { parseReleaseArgs } from "../../src/commands/sp-release";

describe("sp-release args", () => {
  test("parses version and defaults", () => {
    const args = parseReleaseArgs("0.2.0");

    expect(args.version).toBe("0.2.0");
    expect(args.dryRun).toBe(false);
    expect(args.skipTests).toBe(false);
    expect(args.skipPush).toBe(false);
    expect(args.skipRelease).toBe(false);
    expect(args.allowDirty).toBe(false);
  });

  test("supports v-prefixed version and flags", () => {
    const args = parseReleaseArgs("v1.2.3 --dry-run --skip-push --skip-release --allow-dirty --yes");

    expect(args.version).toBe("1.2.3");
    expect(args.dryRun).toBe(true);
    expect(args.skipPush).toBe(true);
    expect(args.skipRelease).toBe(true);
    expect(args.allowDirty).toBe(true);
    expect(args.yes).toBe(true);
  });
});
