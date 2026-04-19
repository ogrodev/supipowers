import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { rmDirWithRetry } from "../../helpers/fs.js";

const RUNNER_PATH = path.resolve(import.meta.dir, "../../../src/qa/scripts/run-e2e-tests.ts");

function installFakePlaywright(binDir: string): void {
  const runnerScriptPath = path.join(binDir, "playwright-cli-runner.js");
  fs.writeFileSync(
    runnerScriptPath,
    [
      "const fs = require('node:fs');",
      "const argsFile = process.env.PW_ARGS_FILE;",
      "if (argsFile) fs.writeFileSync(argsFile, process.argv.slice(2).join(' '));",
      "process.stdout.write(process.env.PW_STDOUT ?? '');",
      "process.stderr.write(process.env.PW_STDERR ?? '');",
      "process.exit(Number(process.env.PW_EXIT_CODE ?? '0'));",
      "",
    ].join("\n"),
  );

  if (process.platform === "win32") {
    const runnerPs1Path = path.join(binDir, "playwright-cli-runner.ps1");
    fs.writeFileSync(
      runnerPs1Path,
      [
        'param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)',
        'if ($env:PW_ARGS_FILE) { Set-Content -Path $env:PW_ARGS_FILE -Value ($Args -join " ") }',
        'if ($env:PW_STDOUT) { [Console]::Out.Write($env:PW_STDOUT) }',
        'if ($env:PW_STDERR) { [Console]::Error.Write($env:PW_STDERR) }',
        '$exitCode = if ($env:PW_EXIT_CODE) { [int]$env:PW_EXIT_CODE } else { 0 }',
        'exit $exitCode',
        '',
      ].join("\r\n"),
    );
    fs.writeFileSync(
      path.join(binDir, "playwright-cli.cmd"),
      `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0\\playwright-cli-runner.ps1" %*\r\n`,
    );
    return;
  }

  fs.writeFileSync(
    path.join(binDir, "playwright-cli"),
    `#!${process.execPath}\nrequire("./playwright-cli-runner.js");\n`,
    { mode: 0o755 },
  );
}

function runRunner(
  binDir: string,
  testDir: string,
  baseUrl: string,
  opts?: {
    testFilter?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  },
): { stdout: string; exitCode: number } {
  const args = [RUNNER_PATH, testDir, baseUrl];
  if (opts?.testFilter) {
    args.push(opts.testFilter);
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...opts?.env,
  };

  try {
    const stdout = execFileSync(process.execPath, args, {
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts?.cwd,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: String(error.stdout ?? "").trim(),
      exitCode: error.status ?? 1,
    };
  }
}

describe("run-e2e-tests.ts", () => {
  let tmpDir: string;
  let binDir: string;
  let testDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-e2e-test-"));
    binDir = path.join(tmpDir, "bin");
    testDir = path.join(tmpDir, "tests");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmDirWithRetry(tmpDir);
  });

  test("exits with error JSON when playwright is not installed", () => {
    const env = {
      ...process.env,
      PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
    };

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env,
      cwd: tmpDir,
    });

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain("playwright not found");
    expect(result.error).toContain("npm install -g @playwright/cli@latest");
    expect(result.total).toBe(0);
  });

  test("uses local node_modules/.bin fallback when PATH does not contain playwright", () => {
    const localBinDir = path.join(tmpDir, "node_modules", ".bin");
    fs.mkdirSync(localBinDir, { recursive: true });
    installFakePlaywright(localBinDir);

    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Smoke",
          specs: [
            {
              title: "loads",
              file: "smoke.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 100 }] }],
            },
          ],
          suites: [],
        },
      ],
    });

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin",
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "0",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.passed).toBe(1);
  });

  test("exits with error JSON when playwright produces no output", () => {
    installFakePlaywright(binDir);

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_EXIT_CODE: "1",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain("playwright produced no output");
    expect(result.total).toBe(0);
  });

  test("parses passing test results into compact summary", () => {
    installFakePlaywright(binDir);
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Login",
          specs: [
            {
              title: "should log in",
              file: "login.spec.ts",
              line: 5,
              tests: [{ results: [{ status: "passed", duration: 1200 }] }],
            },
          ],
          suites: [],
        },
      ],
    });

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "0",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.duration).toBe(1200);
    expect(result.failures).toEqual([]);
  });

  test("reports failures with error messages and exits non-zero", () => {
    installFakePlaywright(binDir);
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Dashboard",
          specs: [
            {
              title: "loads chart",
              file: "dashboard.spec.ts",
              line: 10,
              tests: [
                {
                  results: [
                    {
                      status: "failed",
                      duration: 3500,
                      error: { message: "Element not visible" },
                    },
                  ],
                },
              ],
            },
          ],
          suites: [],
        },
      ],
    });

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "1",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(2);
    const result = JSON.parse(stdout);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test).toContain("loads chart");
    expect(result.failures[0].error).toBe("Element not visible");
  });

  test("counts timedOut as failed", () => {
    installFakePlaywright(binDir);
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Slow page",
          specs: [
            {
              title: "waits forever",
              file: "slow.spec.ts",
              tests: [{ results: [{ status: "timedOut", duration: 30000 }] }],
            },
          ],
          suites: [],
        },
      ],
    });

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "1",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(2);
    const result = JSON.parse(stdout);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBe("Unknown error");
  });

  test("handles mixed results (pass + fail + skipped)", () => {
    installFakePlaywright(binDir);
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "App",
          specs: [
            {
              title: "passes",
              file: "app.spec.ts",
              line: 1,
              tests: [{ results: [{ status: "passed", duration: 500 }] }],
            },
            {
              title: "fails",
              file: "app.spec.ts",
              line: 10,
              tests: [
                {
                  results: [
                    {
                      status: "failed",
                      duration: 2000,
                      error: { message: "Assertion failed" },
                    },
                  ],
                },
              ],
            },
            {
              title: "skips",
              file: "app.spec.ts",
              line: 20,
              tests: [{ results: [{ status: "skipped", duration: 0 }] }],
            },
          ],
          suites: [],
        },
      ],
    });

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "1",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(2);
    const result = JSON.parse(stdout);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.duration).toBe(2500);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBe("Assertion failed");
  });

  test("creates results directory and writes summary.json", () => {
    installFakePlaywright(binDir);
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Smoke",
          specs: [
            {
              title: "loads",
              file: "smoke.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 100 }] }],
            },
          ],
          suites: [],
        },
      ],
    });

    runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "0",
      },
      cwd: tmpDir,
    });

    const resultsDir = path.join(tmpDir, "results");
    expect(fs.existsSync(resultsDir)).toBe(true);

    const summaryPath = path.join(resultsDir, "summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  test("handles nested suites", () => {
    installFakePlaywright(binDir);
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Auth",
          specs: [],
          suites: [
            {
              title: "Login",
              specs: [
                {
                  title: "valid creds",
                  file: "auth.spec.ts",
                  line: 5,
                  tests: [{ results: [{ status: "passed", duration: 800 }] }],
                },
              ],
              suites: [],
            },
          ],
        },
      ],
    });

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: pwOutput,
        PW_EXIT_CODE: "0",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("passes test_filter as --grep to playwright", () => {
    installFakePlaywright(binDir);
    const argsFile = path.join(tmpDir, "pw-args.txt");
    const minimalOutput = JSON.stringify({
      suites: [
        {
          title: "Filtered",
          specs: [
            {
              title: "matching test",
              file: "filtered.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 100 }] }],
            },
          ],
          suites: [],
        },
      ],
    });

    const { exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      testFilter: "login flow",
      env: {
        PW_STDOUT: minimalOutput,
        PW_EXIT_CODE: "0",
        PW_ARGS_FILE: argsFile,
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(0);
    const capturedArgs = fs.readFileSync(argsFile, "utf-8").trim();
    expect(capturedArgs).toContain("--grep");
    expect(capturedArgs).toContain("login flow");
  });

  test("emits parse error JSON when playwright outputs malformed data", () => {
    installFakePlaywright(binDir);

    const { stdout, exitCode } = runRunner(binDir, testDir, "http://localhost:3000", {
      env: {
        PW_STDOUT: "not valid json at all",
        PW_EXIT_CODE: "1",
      },
      cwd: tmpDir,
    });

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain("Failed to parse playwright output");
    expect(result.total).toBe(0);
  });
});
