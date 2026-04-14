import { describe, expect, mock, test } from "bun:test";
import { createCustomHandler } from "../../../src/release/channels/custom.js";

const OK = { stdout: "", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "error", code: 1 };

describe("createCustomHandler", () => {
  test("creates handler with correct id and label", () => {
    const handler = createCustomHandler("my-forge", {
      label: "My Forgejo",
      publishCommand: "echo release",
    });
    expect(handler.id).toBe("my-forge");
    expect(handler.label).toBe("My Forgejo");
  });

  describe("detect", () => {
    test("always available when no detectCommand is set", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: "echo release",
      });
      const exec = mock();
      const status = await handler.detect(exec, "/cwd");

      expect(status.channel).toBe("my-forge");
      expect(status.available).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    });

    test("available when detectCommand succeeds", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: "echo release",
        detectCommand: "tea login list",
      });
      const exec = mock().mockResolvedValue(OK);
      const status = await handler.detect(exec, "/cwd");

      expect(status.channel).toBe("my-forge");
      expect(status.available).toBe(true);
      expect(exec).toHaveBeenCalledWith("sh", ["-c", "tea login list"], { cwd: "/cwd" });
    });

    test("unavailable when detectCommand fails", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: "echo release",
        detectCommand: "tea login list",
      });
      const exec = mock().mockResolvedValue(FAIL);
      const status = await handler.detect(exec, "/cwd");

      expect(status.channel).toBe("my-forge");
      expect(status.available).toBe(false);
    });

    test("unavailable when detectCommand throws", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: "echo release",
        detectCommand: "nonexistent-cmd",
      });
      const exec = mock().mockRejectedValue(new Error("command not found"));
      const status = await handler.detect(exec, "/cwd");

      expect(status.available).toBe(false);
    });
  });

  describe("publish", () => {
    test("passes tag, version, and changelog through env-backed placeholders", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: 'tea release create --tag ${tag} --title ${tag} --note "${changelog}"',
      });
      const exec = mock().mockResolvedValue(OK);
      const changelog = 'fixed "quotes" and $(shell) safely';
      const result = await handler.publish(exec, {
        version: "1.2.3",
        tag: "v1.2.3",
        changelog,
        cwd: "/project",
      });

      expect(result.success).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        "sh",
        ["-c", 'tea release create --tag ${tag} --title ${tag} --note "${changelog}"'],
        {
          cwd: "/project",
          env: {
            tag: "v1.2.3",
            version: "1.2.3",
            changelog,
          },
        },
      );
    });

    test("returns error when publishCommand fails", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: "false",
      });
      const exec = mock().mockResolvedValue({ stdout: "", stderr: "denied", code: 1 });
      const result = await handler.publish(exec, {
        version: "1.0.0",
        tag: "v1.0.0",
        changelog: "",
        cwd: "/project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
    });

    test("returns error when publishCommand throws", async () => {
      const handler = createCustomHandler("my-forge", {
        label: "My Forgejo",
        publishCommand: "echo hi",
      });
      const exec = mock().mockRejectedValue(new Error("exec failed"));
      const result = await handler.publish(exec, {
        version: "1.0.0",
        tag: "v1.0.0",
        changelog: "",
        cwd: "/project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exec failed");
    });
  });
});
