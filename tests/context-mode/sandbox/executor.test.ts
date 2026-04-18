import { describe, test, expect } from "bun:test";
import os from "node:os";
import { executeCode } from "../../../src/context-mode/sandbox/executor.js";
import { getRunner } from "../../../src/context-mode/sandbox/runners.js";

describe("executeCode", () => {
  test("shell: echo hello", async () => {
    const result = await executeCode("shell", 'echo "hello"');
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  test("javascript via bun: console.log(42)", async () => {
    const result = await executeCode("javascript", "console.log(42)");
    expect(result.stdout.trim()).toBe("42");
    expect(result.exitCode).toBe(0);
  });

  test("python selects the OS-native launcher", () => {
    const runner = getRunner("python");
    const expectedBinary = process.platform === "win32" ? ["python"] : ["python3"];
    expect(runner.binary).toEqual(expectedBinary);
  });

  test("python: print ok", async () => {
    const result = await executeCode("python", 'print("ok")');
    expect(result.stdout.trim()).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  test("timeout kills process", async () => {
    const result = await executeCode(
      "shell",
      "while true; do sleep 0.01; done",
      { timeout: 500 },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Timeout");
  }, 10_000);

  test("non-zero exit code", async () => {
    const result = await executeCode("shell", "exit 1");
    expect(result.exitCode).toBe(1);
  });

  test("stderr capture", async () => {
    const result = await executeCode("shell", "echo err >&2");
    expect(result.stderr.trim()).toBe("err");
  });

  test("cwd option", async () => {
    const tmp = os.tmpdir();
    const result = await executeCode("shell", "pwd", { cwd: tmp });
    // os.tmpdir() may return a symlink (e.g. /var -> /private/var on macOS)
    // Resolve both to compare canonical paths
    const { realpathSync } = await import("node:fs");
    const expected = realpathSync(tmp);
    const actual = realpathSync(result.stdout.trim());
    expect(actual).toBe(expected);
  });

  test("env vars", async () => {
    const result = await executeCode("shell", "echo $MY_VAR", {
      env: { MY_VAR: "test123" },
    });
    expect(result.stdout.trim()).toBe("test123");
  });

  test("invalid language throws", async () => {
    expect(executeCode("brainfuck", "+++")).rejects.toThrow("Unsupported language");
  });

  test("duration is tracked", async () => {
    const result = await executeCode("shell", "echo fast");
    expect(result.duration).toBeGreaterThan(0);
  });

  test("background mode returns without killing", async () => {
    const result = await executeCode(
      "shell",
      'echo "bg-started"; sleep 30',
      { background: true, timeout: 500 },
    );
    // background returns exitCode 0 (still alive)
    expect(result.exitCode).toBe(0);
  }, 10_000);
});
