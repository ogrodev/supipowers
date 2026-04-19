import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findExecutable } from "../../utils/executable.js";

interface PlaywrightResultEntry {
  test: string;
  file: string;
  status: string;
  duration: number;
  error: string | null;
}

interface PlaywrightSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: Array<{
    test: string;
    file: string;
    error: string;
  }>;
  error?: string;
}

function quoteCmdArgument(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnPlaywright(
  playwrightBinary: string,
  playwrightArgs: string[],
  cwd: string,
  baseUrl: string,
  env: NodeJS.ProcessEnv,
  encoding: BufferEncoding,
 ) {
  const spawnOptions = {
    cwd,
    env: { ...env, BASE_URL: baseUrl },
    encoding,
  } as const;

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(playwrightBinary)) {
    const commandLine = [playwrightBinary, ...playwrightArgs].map(quoteCmdArgument).join(" ");
    return spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], spawnOptions);
  }

  return spawnSync(playwrightBinary, playwrightArgs, spawnOptions);
}

function resolvePlaywrightBinary(cwd: string): string | null {
  return findExecutable("playwright-cli", {
    cwd,
    localDirs: [path.join("node_modules", ".bin")],
    preferLocal: true,
  });
}

function collectTestResults(suite: any, parentTitle: string, results: PlaywrightResultEntry[]): void {
  const suiteTitle = typeof suite?.title === "string" && suite.title.length > 0
    ? (parentTitle ? `${parentTitle} > ${suite.title}` : suite.title)
    : parentTitle;

  for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
    const specTitle = typeof spec?.title === "string" && spec.title.length > 0
      ? `${suiteTitle} > ${spec.title}`
      : suiteTitle;
    const file = `${spec?.file ?? ""}${spec?.line ? `:${spec.line}` : ""}`;

    for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
      for (const result of Array.isArray(test?.results) ? test.results : []) {
        results.push({
          test: specTitle,
          file,
          status: String(result?.status ?? "unknown"),
          duration: Number(result?.duration ?? 0),
          error: result?.error?.message ?? null,
        });
      }
    }
  }

  for (const child of Array.isArray(suite?.suites) ? suite.suites : []) {
    collectTestResults(child, suiteTitle, results);
  }
}

export function summarizePlaywrightOutput(raw: string): PlaywrightSummary {
  const parsed = JSON.parse(raw);
  const results: PlaywrightResultEntry[] = [];

  for (const suite of Array.isArray(parsed?.suites) ? parsed.suites : []) {
    collectTestResults(suite, "", results);
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed" || result.status === "timedOut").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const duration = results.reduce((sum, result) => sum + result.duration, 0);
  const failures = results
    .filter((result) => result.status === "failed" || result.status === "timedOut")
    .map((result) => ({
      test: result.test,
      file: result.file,
      error: result.error ?? "Unknown error",
    }));

  return {
    total: results.length,
    passed,
    failed,
    skipped,
    duration,
    failures,
  };
}

function buildErrorSummary(message: string): PlaywrightSummary {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    failures: [],
    error: message,
  };
}

export function runE2eTests(
  testDir: string,
  baseUrl: string,
  testFilter: string,
  cwd: string,
): { exitCode: number; stdout: string } {
  const resultsDir = path.resolve(testDir, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });

  const rawOutputPath = path.join(resultsDir, "raw-results.json");
  const playwrightStderrPath = path.join(resultsDir, "playwright-stderr.log");
  const summaryPath = path.join(resultsDir, "summary.json");
  const nodeParseStderrPath = path.join(resultsDir, "node-parse-stderr.log");

  const playwrightBinary = resolvePlaywrightBinary(cwd);
  if (!playwrightBinary) {
    const stdout = JSON.stringify(
      buildErrorSummary("playwright not found. Install with: npm install -g @playwright/cli@latest"),
    );
    return { exitCode: 1, stdout };
  }

  const playwrightArgs = [
    "test",
    testDir,
    "--reporter=json",
    `--output=${resultsDir}`,
  ];

  if (testFilter.length > 0) {
    playwrightArgs.push("--grep", testFilter);
  }

  const result = spawnPlaywright(
    playwrightBinary,
    playwrightArgs,
    cwd,
    baseUrl,
    process.env,
    "utf8",
  );

  const rawOutput = result.stdout ?? "";
  const stderrOutput = result.stderr ?? "";
  fs.writeFileSync(rawOutputPath, rawOutput);
  fs.writeFileSync(playwrightStderrPath, stderrOutput);

  if (rawOutput.trim().length === 0) {
    const stdout = JSON.stringify(
      buildErrorSummary(
        `playwright produced no output (exit code: ${result.status ?? 1}). See ${playwrightStderrPath} for details.`,
      ),
    );
    return { exitCode: 1, stdout };
  }

  try {
    const summary = summarizePlaywrightOutput(rawOutput);
    const stdout = JSON.stringify(summary);
    fs.writeFileSync(summaryPath, stdout);
    return {
      exitCode: summary.failed > 0 ? 2 : 0,
      stdout,
    };
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    fs.writeFileSync(nodeParseStderrPath, message);
    const stdout = JSON.stringify(
      buildErrorSummary(`Failed to parse playwright output. See ${nodeParseStderrPath} for details.`),
    );
    return { exitCode: 1, stdout };
  }
}

function main(): void {
  const [testDir, baseUrl, testFilter = ""] = process.argv.slice(2);
  if (!testDir || !baseUrl) {
    const stdout = JSON.stringify(
      buildErrorSummary("Usage: run-e2e-tests.ts <test_dir> <base_url> [test_filter]"),
    );
    console.log(stdout);
    process.exit(1);
  }

  const result = runE2eTests(testDir, baseUrl, testFilter, process.cwd());
  console.log(result.stdout);
  process.exit(result.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
