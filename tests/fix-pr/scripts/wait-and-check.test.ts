import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { rmDirWithRetry } from "../../helpers/fs.js";

const RUNNER_PATH = path.resolve(import.meta.dir, "../../../src/fix-pr/scripts/wait-and-check.ts");

function installFakeGh(binDir: string): void {
  const runnerScriptPath = path.join(binDir, "gh-runner.js");
  fs.writeFileSync(
    runnerScriptPath,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const endpoint = args[2] ?? '';",
      "const argsFile = process.env.GH_ARGS_FILE;",
      "if (argsFile) fs.appendFileSync(argsFile, JSON.stringify(args) + '\\n');",
      "if (endpoint.includes('/comments')) {",
      "  process.stdout.write(process.env.GH_INLINE_OUTPUT ?? '');",
      "  process.stderr.write(process.env.GH_INLINE_STDERR ?? '');",
      "  process.exit(Number(process.env.GH_INLINE_EXIT_CODE ?? '0'));",
      "}",
      "if (endpoint.includes('/reviews')) {",
      "  process.stdout.write(process.env.GH_REVIEW_OUTPUT ?? '');",
      "  process.stderr.write(process.env.GH_REVIEW_STDERR ?? '');",
      "  process.exit(Number(process.env.GH_REVIEW_EXIT_CODE ?? '0'));",
      "}",
      "process.exit(Number(process.env.GH_EXIT_CODE ?? '0'));",
      "",
    ].join("\n"),
  );

  if (process.platform === "win32") {
    const runnerPs1Path = path.join(binDir, "gh-runner.ps1");
    fs.writeFileSync(
      runnerPs1Path,
      [
        'param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)',
        'if ($env:GH_ARGS_FILE) { Add-Content -Path $env:GH_ARGS_FILE -Value ($Args -join " ") }',
        '$joined = $Args -join " "',
        'if ($joined -like "*/comments*") {',
        '  if ($env:GH_INLINE_OUTPUT) { [Console]::Out.Write($env:GH_INLINE_OUTPUT) }',
        '  if ($env:GH_INLINE_STDERR) { [Console]::Error.Write($env:GH_INLINE_STDERR) }',
        '  exit $(if ($env:GH_INLINE_EXIT_CODE) { [int]$env:GH_INLINE_EXIT_CODE } else { 0 })',
        '}',
        'if ($joined -like "*/reviews*") {',
        '  if ($env:GH_REVIEW_OUTPUT) { [Console]::Out.Write($env:GH_REVIEW_OUTPUT) }',
        '  if ($env:GH_REVIEW_STDERR) { [Console]::Error.Write($env:GH_REVIEW_STDERR) }',
        '  exit $(if ($env:GH_REVIEW_EXIT_CODE) { [int]$env:GH_REVIEW_EXIT_CODE } else { 0 })',
        '}',
        'exit $(if ($env:GH_EXIT_CODE) { [int]$env:GH_EXIT_CODE } else { 0 })',
        '',
      ].join("\r\n"),
    );
    fs.writeFileSync(
      path.join(binDir, "gh.cmd"),
      `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0\\gh-runner.ps1" %*\r\n`,
    );
    return;
  }

  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!${process.execPath}\nrequire("./gh-runner.js");\n`,
    { mode: 0o755 },
  );
}

function buildRunnerEnv(binDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(process.platform === "win32" ? { PATHEXT: ".CMD;.EXE;.BAT;.COM" } : {}),
    ...env,
  };
}

function runRunner(
  binDir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER_PATH, ...args], {
      cwd,
      env: buildRunnerEnv(binDir, env),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: String(error.stdout ?? "").trim(),
      exitCode: error.status ?? 1,
    };
  }
}

describe("wait-and-check.ts", () => {
  let tmpDir: string;
  let sessionDir: string;
  let snapshotsDir: string;
  let binDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-wait-check-"));
    sessionDir = path.join(tmpDir, "session");
    snapshotsDir = path.join(sessionDir, "snapshots");
    binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    installFakeGh(binDir);
  });

  afterEach(() => {
    rmDirWithRetry(tmpDir);
  });

  test("emits new and changed comments before the JSON summary", () => {
    fs.writeFileSync(
      path.join(snapshotsDir, "comments-0.jsonl"),
      [
        JSON.stringify({ id: 1, updatedAt: "2026-04-16T00:00:00Z", body: "old", user: "reviewer" }),
      ].join("\n") + "\n",
    );

    const inlineOutput = [
      JSON.stringify({ id: 1, updatedAt: "2026-04-17T00:00:00Z", body: "updated", user: "reviewer" }),
      JSON.stringify({ id: 2, updatedAt: "2026-04-17T00:00:00Z", body: "new", user: "reviewer" }),
    ].join("\n") + "\n";

    const { stdout, exitCode } = runRunner(
      binDir,
      [sessionDir, "0", "1", "owner/repo", "42"],
      {
        GH_INLINE_OUTPUT: inlineOutput,
        GH_REVIEW_OUTPUT: "",
      },
      tmpDir,
    );

    expect(exitCode).toBe(0);
    const lines = stdout.split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 1, body: "updated" });
    expect(JSON.parse(lines[1])).toMatchObject({ id: 2, body: "new" });
    expect(JSON.parse(lines[2])).toEqual({ hasNewComments: true, count: 2, iteration: 1 });
    expect(fs.existsSync(path.join(snapshotsDir, "comments-1.jsonl"))).toBe(true);
  });

  test("surfaces fetch failures instead of silently reporting no new comments", () => {
    const { stdout, exitCode } = runRunner(
      binDir,
      [sessionDir, "0", "1", "owner/repo", "42"],
      {
        GH_INLINE_EXIT_CODE: "1",
        GH_INLINE_STDERR: "inline failed",
        GH_REVIEW_EXIT_CODE: "1",
        GH_REVIEW_STDERR: "review failed",
      },
      tmpDir,
    );

    expect(exitCode).toBe(1);
    const summary = JSON.parse(stdout);
    expect(summary.hasNewComments).toBe(false);
    expect(summary.count).toBe(0);
    expect(summary.iteration).toBe(1);
    expect(summary.error).toContain("inline failed");
  });
});
