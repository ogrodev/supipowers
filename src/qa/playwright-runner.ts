import type { ExtensionAPI, ExtensionCommandContext, ExecResult } from "@mariozechner/pi-coding-agent";
import { basename, join } from "node:path";
import type { QaCaseResult, QaMatrix } from "./types";
import { appendQaExecutionLog, type QaRunWorkspace } from "./storage";

interface PlaywrightInvoker {
  command: string;
  prefixArgs: string[];
}

interface ExecOutcome {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function splitCommandLine(line: string): string[] {
  const tokens = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((token) => token.replace(/^['"]|['"]$/g, "")).filter((token) => token.length > 0);
}

async function probeInvoker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  command: string,
  args: string[],
): Promise<boolean> {
  const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 20_000 });
  return result.code === 0;
}

export async function detectPlaywrightInvoker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<PlaywrightInvoker | undefined> {
  if (await probeInvoker(pi, ctx, "playwright-cli", ["--help"])) {
    return { command: "playwright-cli", prefixArgs: [] };
  }

  if (await probeInvoker(pi, ctx, "npx", ["playwright-cli", "--help"])) {
    return { command: "npx", prefixArgs: ["playwright-cli"] };
  }

  return undefined;
}

async function runCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  invoker: PlaywrightInvoker,
  run: QaRunWorkspace,
  scope: string,
  args: string[],
): Promise<ExecOutcome> {
  const commandArgs = [...invoker.prefixArgs, ...args];
  const startedAt = Date.now();
  let result: ExecResult;

  try {
    result = await pi.exec(invoker.command, commandArgs, { cwd: ctx.cwd, timeout: 90_000 });
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    appendQaExecutionLog(run.executionLogPath, {
      ts: new Date().toISOString(),
      scope,
      command: invoker.command,
      args: commandArgs,
      code: -1,
      stdout: "",
      stderr,
      durationMs: Date.now() - startedAt,
    });

    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr,
    };
  }

  appendQaExecutionLog(run.executionLogPath, {
    ts: new Date().toISOString(),
    scope,
    command: invoker.command,
    args: commandArgs,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
  });

  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function captureScreenshot(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  invoker: PlaywrightInvoker,
  run: QaRunWorkspace,
  scope: string,
  filename: string,
): Promise<string | undefined> {
  const fullPath = join(run.screenshotsDir, filename);
  const result = await runCommand(pi, ctx, invoker, run, scope, ["screenshot", `--filename=${fullPath}`]);
  return result.ok ? basename(fullPath) : undefined;
}

export interface QaExecutionRunInput {
  matrix: QaMatrix;
  run: QaRunWorkspace;
  authSetupCommands: string[];
}

export interface QaExecutionRunResult {
  ok: boolean;
  results: QaCaseResult[];
  fatalError?: string;
}

export async function runQaMatrixWithPlaywright(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  input: QaExecutionRunInput,
): Promise<QaExecutionRunResult> {
  const invoker = await detectPlaywrightInvoker(pi, ctx);
  if (!invoker) {
    return {
      ok: false,
      results: [],
      fatalError: "playwright-cli is not available. Install it globally or use npx playwright-cli.",
    };
  }

  const openResult = await runCommand(
    pi,
    ctx,
    invoker,
    input.run,
    "session",
    ["open", input.matrix.targetUrl],
  );

  if (!openResult.ok) {
    return {
      ok: false,
      results: [],
      fatalError: `Failed to open browser session: ${openResult.stderr || openResult.stdout || "unknown error"}`,
    };
  }

  for (const line of input.authSetupCommands) {
    const tokens = splitCommandLine(line);
    if (tokens.length === 0) continue;

    // eslint-disable-next-line no-await-in-loop
    const authResult = await runCommand(pi, ctx, invoker, input.run, "auth", tokens);
    if (!authResult.ok) {
      await captureScreenshot(pi, ctx, invoker, input.run, "auth", "auth-failure.png");
      return {
        ok: false,
        results: [],
        fatalError: `Auth setup command failed: ${line}`,
      };
    }
  }

  const results: QaCaseResult[] = [];

  for (const testCase of input.matrix.cases) {
    const startedAt = new Date().toISOString();
    const screenshots: string[] = [];
    const commands: QaCaseResult["commands"] = [];
    let passed = true;
    let error: string | undefined;

    const startShot = await captureScreenshot(
      pi,
      ctx,
      invoker,
      input.run,
      testCase.id,
      `${testCase.id}-start.png`,
    );
    if (startShot) screenshots.push(startShot);

    for (const line of testCase.commandLines) {
      const tokens = splitCommandLine(line);
      if (tokens.length === 0) continue;

      // eslint-disable-next-line no-await-in-loop
      const outcome = await runCommand(pi, ctx, invoker, input.run, testCase.id, tokens);
      commands.push({
        line,
        ok: outcome.ok,
        code: outcome.code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      });

      if (!outcome.ok) {
        passed = false;
        error = `Command failed (${outcome.code}): ${line}`;

        // eslint-disable-next-line no-await-in-loop
        const failedShot = await captureScreenshot(
          pi,
          ctx,
          invoker,
          input.run,
          testCase.id,
          `${testCase.id}-failure.png`,
        );
        if (failedShot) screenshots.push(failedShot);
        break;
      }
    }

    const endShot = await captureScreenshot(
      pi,
      ctx,
      invoker,
      input.run,
      testCase.id,
      `${testCase.id}-end.png`,
    );
    if (endShot) screenshots.push(endShot);

    results.push({
      caseId: testCase.id,
      title: testCase.title,
      severity: testCase.severity,
      passed,
      startedAt,
      finishedAt: new Date().toISOString(),
      error,
      screenshots,
      commands,
    });
  }

  await runCommand(pi, ctx, invoker, input.run, "session", ["close"]);

  return {
    ok: true,
    results,
  };
}
