import { describe, expect, test } from "vitest";
import {
  bumpSemver,
  detectRecommendedBump,
  normalizeSemver,
  pickLatestSemverTag,
} from "../../src/release/versioning";

describe("release versioning", () => {
  test("normalizes semver strings", () => {
    expect(normalizeSemver("v1.2.3")).toBe("1.2.3");
    expect(normalizeSemver("1.2.3")).toBe("1.2.3");
    expect(normalizeSemver("banana")).toBeUndefined();
  });

  test("picks latest semver tag from sorted tag list", () => {
    const latest = pickLatestSemverTag(["nightly", "v1.4.0", "v1.3.0"]);
    expect(latest).toEqual({ tag: "v1.4.0", version: "1.4.0" });
  });

  test("bumps semver levels", () => {
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
  });

  test("detects bump from conventional commit messages", () => {
    expect(detectRecommendedBump(["fix: typo"])).toBe("patch");
    expect(detectRecommendedBump(["feat: new release command"])).toBe("minor");
    expect(detectRecommendedBump(["feat!: remove old API"])).toBe("major");
    expect(detectRecommendedBump(["refactor: internals\n\nBREAKING CHANGE: renamed output"])).toBe("major");
  });
});
