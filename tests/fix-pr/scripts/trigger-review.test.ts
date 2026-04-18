import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { rmDirWithRetry } from "../../helpers/fs.js";

const RUNNER_PATH = path.resolve(import.meta.dir, "../../../src/fix-pr/scripts/trigger-review.ts");

function installFakeGh(binDir: string): void {
  const runnerScriptPath = path.join(binDir, "gh-runner.js");
  fs.writeFileSync(
    runnerScriptPath,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "const argsFile = process.env.GH_ARGS_FILE;",
      "if (argsFile) fs.appendFileSync(argsFile, JSON.stringify(args) + '\\n');",
      "const joined = args.join(' ');",
      "const exitCode = joined.includes('/requested_reviewers')",
      "  ? Number(process.env.GH_REQUESTED_REVIEWERS_EXIT_CODE ?? process.env.GH_EXIT_CODE ?? '0')",
      "  : Number(process.env.GH_COMMENT_EXIT_CODE ?? process.env.GH_EXIT_CODE ?? '0');",
      "process.stdout.write(process.env.GH_STDOUT ?? '');",
      "process.stderr.write(process.env.GH_STDERR ?? '');",
      "process.exit(exitCode);",
      "",
    ].join("\n"),
  );

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "gh.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0\\gh-runner.js" %*\r\n`,
    );
    return;
  }

  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!${process.execPath}\nrequire("./gh-runner.js");\n`,
    { mode: 0o755 },
  );
}

function runRunner(args: string[], env?: NodeJS.ProcessEnv): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER_PATH, ...args], {
      env: {
        ...process.env,
        ...env,
      },
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

describe("trigger-review.ts", () => {
  let tmpDir: string;
  let binDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-trigger-review-"));
    binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    installFakeGh(binDir);
  });

  afterEach(() => {
    rmDirWithRetry(tmpDir);
  });

  test("posts a reviewer trigger comment for coderabbit", () => {
    const argsFile = path.join(tmpDir, "gh-args.txt");
    const { stdout, exitCode } = runRunner(
      ["owner/repo", "42", "coderabbit", "@coderabbit review"],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_ARGS_FILE: argsFile,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ triggered: true, reviewer: "coderabbit" });

    const calls = fs.readFileSync(argsFile, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("repos/owner/repo/issues/42/comments");
    expect(calls[0]).toContain("body=@coderabbit review");
  });

  test("treats the copilot requested-reviewer call as best effort", () => {
    const argsFile = path.join(tmpDir, "gh-args.txt");
    const { stdout, exitCode } = runRunner(
      ["owner/repo", "42", "copilot"],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_ARGS_FILE: argsFile,
        GH_REQUESTED_REVIEWERS_EXIT_CODE: "1",
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ triggered: true, reviewer: "copilot" });

    const calls = fs.readFileSync(argsFile, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("repos/owner/repo/pulls/42/requested_reviewers");
    expect(calls[0]).toContain("reviewers[]=copilot");
  });

  test("returns a usage error for unknown reviewers without calling gh", () => {
    const { stdout, exitCode } = runRunner(["owner/repo", "42", "mystery-reviewer"], {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      triggered: false,
      reviewer: "mystery-reviewer",
      error: "unknown reviewer type: mystery-reviewer",
    });
  });
});
