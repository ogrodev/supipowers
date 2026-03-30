// tests/release/detector.test.ts
import { detectChannels } from "../../src/release/detector.js";

const OK = { stdout: "", stderr: "", code: 0 };
const FAIL = { stdout: "", stderr: "", code: 1 };

describe("detectChannels", () => {
  test("both channels available when both execs return code 0", async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    const results = await detectChannels(exec, "/cwd");

    const gh = results.find((r) => r.channel === "github")!;
    const npm = results.find((r) => r.channel === "npm")!;

    expect(gh.available).toBe(true);
    expect(npm.available).toBe(true);
    expect(results).toHaveLength(2);
  });

  test("only GitHub available when npm returns non-zero", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(OK) // gh auth status
      .mockResolvedValueOnce(FAIL); // npm whoami

    const results = await detectChannels(exec, "/cwd");

    const gh = results.find((r) => r.channel === "github")!;
    const npm = results.find((r) => r.channel === "npm")!;

    expect(gh.available).toBe(true);
    expect(npm.available).toBe(false);
    expect(npm.detail).toContain("npm login");
  });

  test("only npm available when gh throws (not installed)", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("gh: command not found")) // gh auth status throws
      .mockResolvedValueOnce({ stdout: "alice\n", stderr: "", code: 0 }); // npm whoami

    const results = await detectChannels(exec, "/cwd");

    const gh = results.find((r) => r.channel === "github")!;
    const npm = results.find((r) => r.channel === "npm")!;

    expect(gh.available).toBe(false);
    expect(gh.detail).toContain("gh auth login");
    expect(npm.available).toBe(true);
  });

  test("neither available when both return non-zero", async () => {
    const exec = vi.fn().mockResolvedValue(FAIL);
    const results = await detectChannels(exec, "/cwd");

    expect(results.every((r) => r.available === false)).toBe(true);
    expect(results).toHaveLength(2);
  });

  test("npm detail includes username when authenticated", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce({ stdout: "pedro\n", stderr: "", code: 0 });

    const results = await detectChannels(exec, "/cwd");
    const npm = results.find((r) => r.channel === "npm")!;

    expect(npm.available).toBe(true);
    expect(npm.detail).toBe("Logged in as pedro");
  });

  test("npm username is trimmed (handles trailing newline)", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce({ stdout: "  bob  \n", stderr: "", code: 0 });

    const results = await detectChannels(exec, "/cwd");
    const npm = results.find((r) => r.channel === "npm")!;

    expect(npm.detail).toBe("Logged in as bob");
  });

  test("gh throws gracefully — returns unavailable without affecting npm", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT: gh not found"))
      .mockResolvedValueOnce({ stdout: "carol", stderr: "", code: 0 });

    const results = await detectChannels(exec, "/cwd");

    const gh = results.find((r) => r.channel === "github")!;
    const npm = results.find((r) => r.channel === "npm")!;

    expect(gh.available).toBe(false);
    expect(npm.available).toBe(true);
    expect(npm.detail).toBe("Logged in as carol");
  });

  test("passes cwd to each exec call", async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    await detectChannels(exec, "/my/project");

    for (const call of exec.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: "/my/project" });
    }
  });

  test("always returns exactly two results (github and npm)", async () => {
    const exec = vi.fn().mockResolvedValue(OK);
    const results = await detectChannels(exec, "/cwd");

    const channels = results.map((r) => r.channel);
    expect(channels).toContain("github");
    expect(channels).toContain("npm");
    expect(results).toHaveLength(2);
  });
});
