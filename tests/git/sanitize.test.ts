import { describe, test, expect } from "vitest";
import { assertSafeRef, assertSafePath } from "../../src/git/sanitize.js";

describe("assertSafeRef", () => {
  test.each(["feature/auth", "supi/my-plan", "fix-123", "v1.0.0"])(
    "accepts valid ref: %s",
    (ref) => {
      expect(() => assertSafeRef(ref, "branch")).not.toThrow();
    },
  );

  test.each([
    ["main; rm -rf /", "shell injection"],
    ["branch$(cmd)", "command substitution"],
    ["a..b", "double dot"],
    ["name.lock", ".lock suffix"],
    ["", "empty string"],
    ["branch with spaces", "spaces"],
    ["name.", "trailing dot"],
  ])("rejects unsafe ref: %s (%s)", (ref) => {
    expect(() => assertSafeRef(ref, "branch")).toThrow("Unsafe branch");
  });
});

describe("assertSafePath", () => {
  test.each(["/project/.worktrees/auth", "./relative/path"])(
    "accepts valid path: %s",
    (p) => {
      expect(() => assertSafePath(p, "path")).not.toThrow();
    },
  );

  test.each([
    ["/path;rm -rf/", "semicolon"],
    ["/path$(cmd)", "command substitution"],
    ["", "empty string"],
  ])("rejects unsafe path: %s (%s)", (p) => {
    expect(() => assertSafePath(p, "path")).toThrow("Unsafe path");
  });
});
