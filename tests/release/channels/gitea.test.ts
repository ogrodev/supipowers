import { describe, expect, mock, test } from "bun:test";
import { gitea } from "../../../src/release/channels/gitea.js";

const OK = { stdout: "Name\tSSH-URL\nmy-gitea\tssh://...", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "", code: 1 };

describe("gitea channel handler", () => {
  describe("detect", () => {
    test("available when tea login list returns code 0 with output", async () => {
      const exec = mock().mockResolvedValue(OK);
      const status = await gitea.detect(exec, "/cwd");

      expect(status.channel).toBe("gitea");
      expect(status.available).toBe(true);
      expect(exec).toHaveBeenCalledWith("tea", ["login", "list"], { cwd: "/cwd" });
    });

    test("unavailable when tea login list returns empty stdout", async () => {
      const exec = mock().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
      const status = await gitea.detect(exec, "/cwd");

      expect(status.channel).toBe("gitea");
      expect(status.available).toBe(false);
    });

    test("unavailable when tea returns non-zero", async () => {
      const exec = mock().mockResolvedValue(FAIL);
      const status = await gitea.detect(exec, "/cwd");

      expect(status.channel).toBe("gitea");
      expect(status.available).toBe(false);
    });

    test("unavailable when tea CLI is not installed", async () => {
      const exec = mock().mockRejectedValue(new Error("tea: command not found"));
      const status = await gitea.detect(exec, "/cwd");

      expect(status.channel).toBe("gitea");
      expect(status.available).toBe(false);
      expect(status.detail).toContain("not installed");
    });
  });

  describe("publish", () => {
    test("calls tea release create with correct args", async () => {
      const exec = mock().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
      const result = await gitea.publish(exec, {
        version: "3.0.0",
        tag: "v3.0.0",
        changelog: "- chore: update",
        cwd: "/project",
      });

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        "tea",
        ["release", "create", "--tag", "v3.0.0", "--title", "v3.0.0", "--note", "- chore: update"],
        { cwd: "/project" },
      );
    });

    test("returns error when tea release create fails", async () => {
      const exec = mock().mockResolvedValue({ stdout: "", stderr: "not found", code: 1 });
      const result = await gitea.publish(exec, {
        version: "3.0.0",
        tag: "v3.0.0",
        changelog: "",
        cwd: "/project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });
});
