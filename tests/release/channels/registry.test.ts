import { describe, expect, mock, test } from "bun:test";
import { resolveChannelHandler, getAllAvailableChannels } from "../../../src/release/channels/registry.js";

const OK = { stdout: "", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "", code: 1 };

describe("resolveChannelHandler", () => {
  test("resolves github to built-in handler", () => {
    const handler = resolveChannelHandler("github", {});
    expect(handler).not.toBeNull();
    expect(handler!.id).toBe("github");
  });

  test("resolves gitlab to built-in handler", () => {
    const handler = resolveChannelHandler("gitlab", {});
    expect(handler).not.toBeNull();
    expect(handler!.id).toBe("gitlab");
  });

  test("resolves gitea to built-in handler", () => {
    const handler = resolveChannelHandler("gitea", {});
    expect(handler).not.toBeNull();
    expect(handler!.id).toBe("gitea");
  });

  test("returns null for unknown channel without custom config", () => {
    const handler = resolveChannelHandler("bitbucket", {});
    expect(handler).toBeNull();
  });

  test("resolves custom channel from config", () => {
    const handler = resolveChannelHandler("my-forge", {
      "my-forge": { label: "My Forgejo", publishCommand: "echo release" },
    });
    expect(handler).not.toBeNull();
    expect(handler!.id).toBe("my-forge");
    expect(handler!.label).toBe("My Forgejo");
  });

  test("custom config overrides built-in handler", () => {
    const handler = resolveChannelHandler("github", {
      github: { label: "Custom GH", publishCommand: "custom-gh-release" },
    });
    expect(handler).not.toBeNull();
    expect(handler!.label).toBe("Custom GH");
  });
});

describe("getAllAvailableChannels", () => {
  test("returns statuses for all 3 built-in channels with no custom", async () => {
    const exec = mock().mockResolvedValue(FAIL);
    const statuses = await getAllAvailableChannels(exec, "/cwd", {});

    const ids = statuses.map((s) => s.channel);
    expect(ids).toContain("github");
    expect(ids).toContain("gitlab");
    expect(ids).toContain("gitea");
    expect(statuses).toHaveLength(3);
  });

  test("includes custom channels in results", async () => {
    const exec = mock().mockResolvedValue(OK);
    const statuses = await getAllAvailableChannels(exec, "/cwd", {
      "my-forge": { label: "My Forgejo", publishCommand: "echo release" },
    });

    const ids = statuses.map((s) => s.channel);
    expect(ids).toContain("my-forge");
    expect(statuses).toHaveLength(4); // 3 built-in + 1 custom
  });

  test("custom channel with same id as built-in does not duplicate and uses custom detection", async () => {
    const exec = mock(async (cmd: string) =>
      cmd === "sh"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 1 },
    );
    const statuses = await getAllAvailableChannels(exec, "/cwd", {
      github: {
        label: "Custom GH",
        detectCommand: "custom-gh-detect",
        publishCommand: "echo",
      },
    });

    const githubEntries = statuses.filter((s) => s.channel === "github");
    expect(githubEntries).toHaveLength(1);
    expect(statuses).toHaveLength(3); // still 3, not 4
    expect(githubEntries[0]).toEqual({
      channel: "github",
      available: true,
      detail: "Detect command succeeded",
    });
    expect(exec.mock.calls.some((call) => call[0] === "sh")).toBe(true);
    expect(exec.mock.calls.some((call) => call[0] === "gh")).toBe(false);
  });
});
