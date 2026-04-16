import { describe, expect, mock, test } from "bun:test";
import { github } from "../../../src/release/channels/github.js";

const OK = { stdout: "", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "not authenticated", code: 1 };
const BASE_CONTEXT = {
  targetName: "@repo/pkg",
  targetId: "@repo/pkg",
  targetPath: "packages/pkg",
  manifestPath: "/project/packages/pkg/package.json",
  packageManager: "bun",
};


describe("github channel handler", () => {
  describe("detect", () => {
    test("available when gh auth returns code 0", async () => {
      const exec = mock().mockResolvedValue(OK);
      const status = await github.detect(exec, "/cwd");

      expect(status.channel).toBe("github");
      expect(status.available).toBe(true);
      expect(exec).toHaveBeenCalledWith("gh", ["auth", "status"], { cwd: "/cwd" });
    });

    test("unavailable when gh auth returns non-zero", async () => {
      const exec = mock().mockResolvedValue(FAIL);
      const status = await github.detect(exec, "/cwd");

      expect(status.channel).toBe("github");
      expect(status.available).toBe(false);
    });

    test("unavailable when gh CLI is not installed", async () => {
      const exec = mock().mockRejectedValue(new Error("gh: command not found"));
      const status = await github.detect(exec, "/cwd");

      expect(status.channel).toBe("github");
      expect(status.available).toBe(false);
      expect(status.detail).toContain("not installed");
    });
  });

  describe("publish", () => {
    test("calls gh release create with correct args", async () => {
      const exec = mock().mockResolvedValue(OK);
      const result = await github.publish(exec, {
        ...BASE_CONTEXT,
        version: "1.0.0",
        tag: "v1.0.0",
        changelog: "- feat: something",
        cwd: "/project",
      });

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        "gh",
        ["release", "create", "v1.0.0", "--title", "v1.0.0", "--notes", "- feat: something"],
        { cwd: "/project" },
      );
    });

    test("returns error when gh release create fails", async () => {
      const exec = mock().mockResolvedValue({ stdout: "", stderr: "release exists", code: 1 });
      const result = await github.publish(exec, {
        ...BASE_CONTEXT,
        version: "1.0.0",
        tag: "v1.0.0",
        changelog: "",
        cwd: "/project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("release exists");
    });

    test("returns error when gh throws", async () => {
      const exec = mock().mockRejectedValue(new Error("network error"));
      const result = await github.publish(exec, {
        ...BASE_CONTEXT,
        version: "1.0.0",
        tag: "v1.0.0",
        changelog: "",
        cwd: "/project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("network error");
    });
  });

  test("has correct id and label", () => {
    expect(github.id).toBe("github");
    expect(github.label).toBe("GitHub Releases");
  });
});
