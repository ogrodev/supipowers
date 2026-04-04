// tests/release/executor.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeRelease } from "../../src/release/executor.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Returns a mock exec that always resolves with code 0 */
function okExec() {
  return mock().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
}

/** Returns a mock exec where call at index `failAt` resolves with code 1 */
function failAt(callIndex: number, stderr = "error") {
  const fn = mock();
  fn.mockImplementation((..._args: unknown[]) => {
    const n = fn.mock.calls.length - 1; // 0-based after call was recorded
    if (n === callIndex) {
      return Promise.resolve({ stdout: "", stderr, code: 1 });
    }
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  });
  return fn;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-exec-"));
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "test", version: "1.0.0" }, null, 2) + "\n",
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("executeRelease", () => {
  describe("happy path with both channels", () => {
    test("returns success result and calls exec in correct order", async () => {
      const mockExec = okExec();

      const result = await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "2.0.0",
        changelog: "- feat: something",
        channels: ["github", "npm"],
        dryRun: false,
      });

      expect(result.version).toBe("2.0.0");
      expect(result.tagCreated).toBe(true);
      expect(result.pushed).toBe(true);
      expect(result.channels).toHaveLength(2);
      expect(result.channels[0]).toEqual({ channel: "github", success: true });
      expect(result.channels[1]).toEqual({ channel: "npm", success: true });

      // No build script → 4 git calls + 2 channel calls = 6 total
      expect(mockExec).toHaveBeenCalledTimes(6);

      const calls = mockExec.mock.calls;
      expect(calls[0]).toEqual(["git", ["add", "-A"], { cwd: tmpDir }]);
      expect(calls[1]).toEqual(["git", ["commit", "-m", "chore(release): v2.0.0"], { cwd: tmpDir }]);
      expect(calls[2]).toEqual([
        "git",
        ["tag", "-a", "v2.0.0", "-m", "Release v2.0.0\n\n- feat: something"],
        { cwd: tmpDir },
      ]);
      expect(calls[3]).toEqual([
        "git",
        ["push", "origin", "HEAD", "--follow-tags"],
        { cwd: tmpDir },
      ]);
      expect(calls[4]).toEqual([
        "gh",
        ["release", "create", "v2.0.0", "--title", "v2.0.0", "--notes", "- feat: something"],
        { cwd: tmpDir },
      ]);
      expect(calls[5]).toEqual(["npm", ["publish"], { cwd: tmpDir }]);
    });
  });

  describe("build script handling", () => {
    test("runs bun run build first when scripts.build is present", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", version: "1.0.0", scripts: { build: "tsc" } }, null, 2) + "\n",
      );
      const mockExec = okExec();

      await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "1.1.0",
        changelog: "",
        channels: [],
        dryRun: false,
      });

      // First call must be the build
      expect(mockExec.mock.calls[0]).toEqual(["bun", ["run", "build"], { cwd: tmpDir }]);
    });

    test("throws when build fails", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", version: "1.0.0", scripts: { build: "tsc" } }, null, 2) + "\n",
      );
      const mockExec = mock().mockResolvedValue({ stdout: "", stderr: "tsc error", code: 1 });

      await expect(
        executeRelease({
          exec: mockExec,
          cwd: tmpDir,
          version: "1.1.0",
          changelog: "",
          channels: [],
          dryRun: false,
        }),
      ).rejects.toThrow("Build failed");

      // Nothing after build should have been called
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    test("skips build step when scripts.build is absent", async () => {
      const mockExec = okExec();

      await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "1.1.0",
        changelog: "",
        channels: [],
        dryRun: false,
      });

      // First call must be git add, not bun
      expect(mockExec.mock.calls[0][0]).toBe("git");
    });
  });

  describe("dry-run mode", () => {
    test("makes no exec calls and returns all-success result", async () => {
      const mockExec = okExec();

      const result = await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "3.0.0",
        changelog: "breaking",
        channels: ["github", "npm"],
        dryRun: true,
      });

      expect(mockExec).not.toHaveBeenCalled();
      expect(result.version).toBe("3.0.0");
      expect(result.tagCreated).toBe(true);
      expect(result.pushed).toBe(true);
      expect(result.channels).toHaveLength(2);
      expect(result.channels.every((c) => c.success)).toBe(true);
    });
  });

  describe("git push failure", () => {
    test("returns pushed=false and skips channels when push exits non-zero", async () => {
      // git add=0, commit=0, tag=0, push=1
      const mockExec = failAt(3);

      const result = await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "1.2.0",
        changelog: "",
        channels: ["github", "npm"],
        dryRun: false,
      });

      expect(result.pushed).toBe(false);
      expect(result.tagCreated).toBe(true); // tag was created before push
      expect(result.channels).toHaveLength(0);
    });
  });

  describe("channel failure non-fatal", () => {
    test("github fails but npm succeeds — both recorded, git flags true", async () => {
      const mockExec = mock();
      mockExec.mockImplementation((cmd: string, args: string[]) => {
        // Fail the gh release create call only
        if (cmd === "gh") {
          return Promise.resolve({ stdout: "", stderr: "gh error", code: 1 });
        }
        return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      });

      const result = await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "1.3.0",
        changelog: "notes",
        channels: ["github", "npm"],
        dryRun: false,
      });

      expect(result.tagCreated).toBe(true);
      expect(result.pushed).toBe(true);

      const gh = result.channels.find((c) => c.channel === "github")!;
      const npm = result.channels.find((c) => c.channel === "npm")!;

      expect(gh.success).toBe(false);
      expect(gh.error).toBeTruthy();
      expect(npm.success).toBe(true);
    });
  });

  describe("package.json version update", () => {
    test("writes new version to package.json on disk", async () => {
      const mockExec = okExec();

      await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "5.0.0",
        changelog: "",
        channels: [],
        dryRun: false,
      });

      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
        version: string;
      };
      expect(updated.version).toBe("5.0.0");
    });
  });

  describe("skipBump option", () => {
    test("does not overwrite package.json version when skipBump is true", async () => {
      // package.json starts at 1.0.0 — we're "releasing" 1.0.0 without bumping
      const mockExec = okExec();

      await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "1.0.0",
        changelog: "",
        channels: [],
        dryRun: false,
        skipBump: true,
      });

      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
        version: string;
      };
      // Should remain 1.0.0, NOT be overwritten
      expect(updated.version).toBe("1.0.0");
    });

    test("still runs git operations when skipBump is true", async () => {
      const mockExec = okExec();

      const result = await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "1.0.0",
        changelog: "notes",
        channels: [],
        dryRun: false,
        skipBump: true,
      });

      expect(result.tagCreated).toBe(true);
      expect(result.pushed).toBe(true);
      // skipBump skips add+commit → only 2 git calls (tag, push)
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    test("overwrites package.json version when skipBump is false", async () => {
      const mockExec = okExec();

      await executeRelease({
        exec: mockExec,
        cwd: tmpDir,
        version: "5.0.0",
        changelog: "",
        channels: [],
        dryRun: false,
        skipBump: false,
      });

      const updated = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
        version: string;
      };
      expect(updated.version).toBe("5.0.0");
    });
  });
});

