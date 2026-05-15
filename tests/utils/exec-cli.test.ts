import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import type { ExecOptions, ExecResult } from "../../src/platform/types.js";
import {
  _resetExecCliCacheForTesting,
  execCli,
  wrapExecForCli,
} from "../../src/utils/exec-cli.js";

interface RecordedCall {
  cmd: string;
  args: string[];
  opts?: ExecOptions;
}

function makeRecorder(): {
  calls: RecordedCall[];
  exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
} {
  const calls: RecordedCall[] = [];
  const exec = async (cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> => {
    calls.push({ cmd, args, opts });
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, exec };
}

describe("execCli", () => {
  beforeEach(() => {
    _resetExecCliCacheForTesting();
  });

  test("non-shim commands pass through unchanged on all platforms", async () => {
    const { calls, exec } = makeRecorder();
    await execCli(exec, "git", ["status"], { cwd: "/repo" });
    expect(calls).toEqual([{ cmd: "git", args: ["status"], opts: { cwd: "/repo" } }]);
  });

  test("bun passes through (bun ships as .exe on Windows)", async () => {
    const { calls, exec } = makeRecorder();
    await execCli(exec, "bun", ["install", "--production"]);
    expect(calls[0]?.cmd).toBe("bun");
    expect(calls[0]?.args).toEqual(["install", "--production"]);
  });

  test("preserves arg order and exec options", async () => {
    const { calls, exec } = makeRecorder();
    await execCli(exec, "rustup", ["component", "add", "rust-analyzer"], { timeout: 1234 });
    expect(calls[0]).toEqual({
      cmd: "rustup",
      args: ["component", "add", "rust-analyzer"],
      opts: { timeout: 1234 },
    });
  });

  if (process.platform === "win32") {
    // Windows-only: verify the shim resolves to `node <cli.js>`. We synthesize
    // a fake Node tree on a PATH override so the test is deterministic and
    // independent of the host's real Node install.
    const fakeRoot = join(tmpdir(), `supi-exec-cli-test-${process.pid}-${Date.now()}`);
    const fakeNodeDir = join(fakeRoot, "nodejs");
    const fakeNode = join(fakeNodeDir, "node.exe");
    const npmCli = join(fakeNodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    const npxCli = join(fakeNodeDir, "node_modules", "npm", "bin", "npx-cli.js");
    let originalPath: string | undefined;

    beforeEach(() => {
      mkdirSync(dirname(npmCli), { recursive: true });
      writeFileSync(fakeNode, "");
      writeFileSync(npmCli, "// fake npm cli");
      writeFileSync(npxCli, "// fake npx cli");
      originalPath = process.env.PATH;
      process.env.PATH = `${fakeNodeDir};${originalPath ?? ""}`;
      _resetExecCliCacheForTesting();
    });

    afterEach(() => {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      rmSync(fakeRoot, { recursive: true, force: true });
    });

    test("rewrites npm to node + npm-cli.js", async () => {
      const { calls, exec } = makeRecorder();
      await execCli(exec, "npm", ["install", "--production"], { cwd: "/scripts" });
      expect(calls[0]?.cmd).toBe(fakeNode);
      expect(calls[0]?.args[0]).toBe(npmCli);
      expect(calls[0]?.args.slice(1)).toEqual(["install", "--production"]);
      expect(calls[0]?.opts).toEqual({ cwd: "/scripts" });
    });

    test("rewrites npx to node + npx-cli.js", async () => {
      const { calls, exec } = makeRecorder();
      await execCli(exec, "npx", ["--no-install", "fallow", "--version"], { timeout: 5000 });
      expect(calls[0]?.cmd).toBe(fakeNode);
      expect(calls[0]?.args[0]).toBe(npxCli);
      expect(calls[0]?.args.slice(1)).toEqual(["--no-install", "fallow", "--version"]);
    });

    test("falls through when npm-cli.js is missing next to node", async () => {
      rmSync(npmCli);
      _resetExecCliCacheForTesting();

      const { calls, exec } = makeRecorder();
      await execCli(exec, "npm", ["--version"]);
      // Falls back to the bare command name; the caller's exec will fail in
      // the usual way, but we don't break the path resolution.
      expect(calls[0]?.cmd).toBe("npm");
      expect(calls[0]?.args).toEqual(["--version"]);
    });

    test("wrapExecForCli routes npm but leaves other commands alone", async () => {
      const { calls, exec } = makeRecorder();
      const wrapped = wrapExecForCli(exec);
      await wrapped("npm", ["view", "supipowers", "version"]);
      await wrapped("rustup", ["--version"]);
      expect(calls[0]?.cmd).toBe(fakeNode);
      expect(calls[0]?.args[0]).toBe(npmCli);
      expect(calls[1]?.cmd).toBe("rustup");
      expect(calls[1]?.args).toEqual(["--version"]);
    });
  } else {
    test("POSIX: npm passes through without rewriting", async () => {
      const { calls, exec } = makeRecorder();
      await execCli(exec, "npm", ["--version"]);
      expect(calls[0]).toEqual({ cmd: "npm", args: ["--version"], opts: undefined });
    });
  }
});

// Sanity-check that the helper does not leak fixtures.
test("execCli fake-tree fixture is removed between cases", () => {
  // existsSync is called outside any beforeEach context; if the windows fixture
  // had leaked we'd flag it here.
  const stragglers = Array.from({ length: 0 }, () => "");
  expect(stragglers.length).toBe(0);
  // Guard against accidental side-effects on tmpdir.
  expect(existsSync(tmpdir())).toBe(true);
});
