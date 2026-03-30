import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

const SCRIPT_PATH = path.resolve(__dirname, "../../../src/qa/scripts/run-e2e-tests.sh");

/**
 * Create a fake `playwright-cli` binary that writes JSON to stdout and exits with the given code.
 * The '\'' idiom (end quote, escaped quote, start quote) embeds literal single quotes
 * inside a single-quoted bash string, keeping $() and backticks inert.
 */
function writeFakePlaywright(binDir: string, jsonOutput: string, exitCode = 0): void {
  const script = `#!/usr/bin/env bash
echo '${jsonOutput.replace(/'/g, "'\\''")}'
exit ${exitCode}
`;
  const binPath = path.join(binDir, "playwright-cli");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
}

/** Create a fake `playwright-cli` that writes nothing to stdout */
function writeSilentPlaywright(binDir: string, exitCode = 1): void {
  const script = `#!/usr/bin/env bash
exit ${exitCode}
`;
  const binPath = path.join(binDir, "playwright-cli");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
}

/** Run the script with a custom PATH that includes the fake playwright-cli */
function runScript(
  binDir: string,
  testDir: string,
  baseUrl: string,
  opts?: { testFilter?: string; env?: NodeJS.ProcessEnv; cwd?: string },
): { stdout: string; exitCode: number } {
  const args = [testDir, baseUrl];
  if (opts?.testFilter) args.push(opts.testFilter);

  const env = opts?.env ?? {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
  };

  try {
    const stdout = execSync(`bash "${SCRIPT_PATH}" ${args.map((a) => `"${a}"`).join(" ")}`, {
      env,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts?.cwd,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "").trim(), exitCode: err.status ?? 1 };
  }
}

describe("run-e2e-tests.sh", () => {
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("exits with error JSON when playwright is not installed", () => {
    // PATH excludes playwright, cwd has no node_modules — both detection paths fail.
    // node is intentionally unreachable on this PATH; the script exits before the node parser.
    const env = {
      ...process.env,
      PATH: "/usr/bin:/bin",
    };

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000", {
      env,
      cwd: tmpDir,
    });

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain("playwright not found");
    expect(result.error).toContain("npm install -g @playwright/cli@latest");
    expect(result.total).toBe(0);
  });

  test("exits with error JSON when playwright produces no output", () => {
    writeSilentPlaywright(binDir, 1);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain("playwright produced no output");
    expect(result.total).toBe(0);
  });

  test("parses passing test results into compact summary", () => {
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Login",
          specs: [
            {
              title: "should log in",
              file: "login.spec.ts",
              line: 5,
              tests: [
                {
                  results: [{ status: "passed", duration: 1200 }],
                },
              ],
            },
          ],
          suites: [],
        },
      ],
    });

    writeFakePlaywright(binDir, pwOutput, 0);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

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

    // Playwright exits 1 on test failure, but the script captures output regardless
    writeFakePlaywright(binDir, pwOutput, 1);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

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
    const pwOutput = JSON.stringify({
      suites: [
        {
          title: "Slow page",
          specs: [
            {
              title: "waits forever",
              file: "slow.spec.ts",
              tests: [
                {
                  results: [{ status: "timedOut", duration: 30000 }],
                },
              ],
            },
          ],
          suites: [],
        },
      ],
    });

    writeFakePlaywright(binDir, pwOutput, 1);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

    expect(exitCode).toBe(2);
    const result = JSON.parse(stdout);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBe("Unknown error");
  });

  test("handles mixed results (pass + fail + skipped)", () => {
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

    writeFakePlaywright(binDir, pwOutput, 1);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

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

    writeFakePlaywright(binDir, pwOutput, 0);
    runScript(binDir, testDir, "http://localhost:3000");

    const resultsDir = path.join(tmpDir, "results");
    expect(fs.existsSync(resultsDir)).toBe(true);

    const summaryPath = path.join(resultsDir, "summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  test("handles nested suites", () => {
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

    writeFakePlaywright(binDir, pwOutput, 0);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
    // The test name includes parent suite titles
    expect(result.failures).toEqual([]);
  });

  test("passes test_filter as --grep to playwright", () => {
    // Fake playwright that records its arguments to a file and emits minimal valid output
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
    const script = `#!/usr/bin/env bash
echo "$@" > "${argsFile}"
echo '${minimalOutput.replace(/'/g, "'\\''")}'
exit 0
`;
    const binPath = path.join(binDir, "playwright-cli");
    fs.writeFileSync(binPath, script, { mode: 0o755 });

    const { exitCode } = runScript(binDir, testDir, "http://localhost:3000", { testFilter: "login flow" });

    expect(exitCode).toBe(0);
    const capturedArgs = fs.readFileSync(argsFile, "utf-8").trim();
    expect(capturedArgs).toContain("--grep");
    expect(capturedArgs).toContain("login flow");
  });

  test("emits parse error JSON when playwright outputs malformed data", () => {
    // Playwright crashes and writes non-JSON garbage to stdout
    writeFakePlaywright(binDir, "not valid json at all", 1);

    const { stdout, exitCode } = runScript(binDir, testDir, "http://localhost:3000");

    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain("Failed to parse playwright output");
    expect(result.total).toBe(0);
  });
});
