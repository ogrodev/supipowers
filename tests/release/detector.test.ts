// tests/release/detector.test.ts
import { describe, expect, mock, test } from "bun:test";
import { detectChannels } from "../../src/release/detector.js";

const OK = { stdout: "", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "", code: 1 };

describe("detectChannels", () => {
  test("returns statuses for all built-in channels", async () => {
    const exec = mock().mockResolvedValue(OK);
    const results = await detectChannels(exec, "/cwd");

    const ids = results.map((r) => r.channel);
    expect(ids).toContain("github");
    expect(ids).toContain("gitlab");
    expect(ids).toContain("gitea");
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  test("github available when gh auth returns code 0", async () => {
    const exec = mock().mockResolvedValue(OK);
    const results = await detectChannels(exec, "/cwd");
    const github = results.find((r) => r.channel === "github")!;

    expect(github.available).toBe(true);
  });

  test("channels unavailable when CLI returns non-zero", async () => {
    const exec = mock().mockResolvedValue(FAIL);
    const results = await detectChannels(exec, "/cwd");

    for (const r of results) {
      expect(r.available).toBe(false);
    }
  });

  test("includes custom channels when provided", async () => {
    const exec = mock().mockResolvedValue(OK);
    const results = await detectChannels(exec, "/cwd", {
      "my-forge": { label: "My Forgejo", publishCommand: "echo release" },
    });

    const ids = results.map((r) => r.channel);
    expect(ids).toContain("my-forge");
    expect(results.length).toBeGreaterThanOrEqual(4);
  });

  test("custom channel without detectCommand is always available", async () => {
    const exec = mock().mockResolvedValue(FAIL); // built-ins will fail
    const results = await detectChannels(exec, "/cwd", {
      "my-forge": { label: "My Forgejo", publishCommand: "echo release" },
    });

    const custom = results.find((r) => r.channel === "my-forge")!;
    expect(custom.available).toBe(true);
  });

  test("passes cwd to exec calls", async () => {
    const exec = mock().mockResolvedValue(OK);
    await detectChannels(exec, "/my/project");

    for (const call of exec.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: "/my/project" });
    }
  });
});
