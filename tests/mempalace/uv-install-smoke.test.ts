import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { detectUvPlatform, ensureUv } from "../../src/mempalace/uv.js";
import type { ProcessRunner } from "../../src/mempalace/runtime.js";

const smokeTest = process.env.MEMPALACE_UV_INSTALL_SMOKE === "1" ? test : test.skip;

const runner: ProcessRunner = async (command, args, options = {}) => {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined) proc.stdin.write(options.input);
  proc.stdin.end();
  const timeout = options.timeoutMs
    ? setTimeout(() => proc.kill(), options.timeoutMs)
    : null;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

describe("MemPalace managed uv install smoke", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-uv-smoke-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  smokeTest("downloads, extracts, and runs uv on the current CI platform", async () => {
    const uvPlatform = detectUvPlatform();
    expect(uvPlatform).not.toBeNull();
    if (!uvPlatform) throw new Error(`unsupported CI platform ${process.platform}/${process.arch}`);

    const result = await ensureUv({
      managedBinDir: tmpDir,
      platform: uvPlatform,
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(fs.existsSync(result.uvPath)).toBe(true);

    const version = await runner(result.uvPath, ["--version"], { timeoutMs: 30_000 });
    expect(version.code, version.stderr || version.stdout).toBe(0);
    expect(`${version.stdout}\n${version.stderr}`).toContain("uv");
  }, 120_000);
});
