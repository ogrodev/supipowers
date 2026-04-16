import { describe, expect, mock, test } from "bun:test";
import { gitlab } from "../../../src/release/channels/gitlab.js";

const OK = { stdout: "", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "not authenticated", code: 1 };
const BASE_CONTEXT = {
  targetName: "@repo/pkg",
  targetId: "@repo/pkg",
  targetPath: "packages/pkg",
  manifestPath: "/project/packages/pkg/package.json",
  packageManager: "bun",
};


describe("gitlab channel handler", () => {
  describe("detect", () => {
    test("available when glab auth returns code 0", async () => {
      const exec = mock().mockResolvedValue(OK);
      const status = await gitlab.detect(exec, "/cwd");

      expect(status.channel).toBe("gitlab");
      expect(status.available).toBe(true);
      expect(exec).toHaveBeenCalledWith("glab", ["auth", "status"], { cwd: "/cwd" });
    });

    test("unavailable when glab auth returns non-zero", async () => {
      const exec = mock().mockResolvedValue(FAIL);
      const status = await gitlab.detect(exec, "/cwd");

      expect(status.channel).toBe("gitlab");
      expect(status.available).toBe(false);
    });

    test("unavailable when glab CLI is not installed", async () => {
      const exec = mock().mockRejectedValue(new Error("glab: command not found"));
      const status = await gitlab.detect(exec, "/cwd");

      expect(status.channel).toBe("gitlab");
      expect(status.available).toBe(false);
      expect(status.detail).toContain("not installed");
    });
  });

  describe("publish", () => {
    test("calls glab release create with correct args", async () => {
      const exec = mock().mockResolvedValue(OK);
      const result = await gitlab.publish(exec, {
        ...BASE_CONTEXT,
        version: "2.0.0",
        tag: "v2.0.0",
        changelog: "- fix: bug",
        cwd: "/project",
      });

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        "glab",
        ["release", "create", "v2.0.0", "--notes", "- fix: bug"],
        { cwd: "/project" },
      );
    });

    test("returns error when glab release create fails", async () => {
      const exec = mock().mockResolvedValue({ stdout: "", stderr: "forbidden", code: 1 });
      const result = await gitlab.publish(exec, {
        ...BASE_CONTEXT,
        version: "2.0.0",
        tag: "v2.0.0",
        changelog: "",
        cwd: "/project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("forbidden");
    });
  });
});
