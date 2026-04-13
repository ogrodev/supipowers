import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getRunner } from "./runners.js";

export interface ExecuteOptions {
  timeout?: number;
  background?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

const DEFAULT_TIMEOUT = 30_000;

export async function executeCode(
  language: string,
  code: string,
  options?: ExecuteOptions,
): Promise<ExecuteResult> {
  const runner = getRunner(language);
  const opts = options ?? {};
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const cwd = opts.cwd ?? process.cwd();

  const id = randomUUID();
  const srcPath = path.join(os.tmpdir(), `ctx-exec-${id}${runner.fileExt}`);
  const outPath = runner.needsCompile
    ? path.join(os.tmpdir(), `ctx-exec-${id}`)
    : undefined;

  fs.writeFileSync(srcPath, code);
  const start = performance.now();

  try {
    // Compile step for compiled languages
    if (runner.needsCompile && runner.compileCmd && outPath) {
      const compileArgs = runner.compileCmd(srcPath, outPath);
      const compileProc = Bun.spawn(compileArgs, {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
      });
      const [compStdout, compStderr] = await Promise.all([
        new Response(compileProc.stdout).text(),
        new Response(compileProc.stderr).text(),
      ]);
      const compileExit = await compileProc.exited;
      if (compileExit !== 0) {
        return {
          stdout: compStdout,
          stderr: compStderr,
          exitCode: compileExit,
          duration: performance.now() - start,
        };
      }
    }

    const execPath = outPath ?? srcPath;
    const args = runner.needsCompile ? [execPath] : [...runner.binary, execPath];

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: { ...process.env, ...opts.env },
    });

    if (opts.background) {
      // Wait up to timeout collecting partial output, then return without killing
      const partial = await collectWithTimeout(proc, timeout);
      return {
        stdout: partial.stdout,
        stderr: partial.stderr,
        exitCode: 0,
        duration: performance.now() - start,
      };
    }

    // Foreground: enforce hard timeout
    const result = await raceTimeout(proc, timeout);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: performance.now() - start,
    };
  } finally {
    cleanup(srcPath);
    if (outPath) cleanup(outPath);
  }
}

/** Race process completion against a timeout. Kills on timeout. */
async function raceTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Start reading streams immediately — they can only be consumed once
  const stdoutP = new Response(proc.stdout as ReadableStream<Uint8Array> | undefined).text();
  const stderrP = new Response(proc.stderr as ReadableStream<Uint8Array> | undefined).text();

  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), timeout)),
  ]);

  if (timedOut) {
    proc.kill("SIGKILL");
    await proc.exited;
  }

  const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

  if (timedOut) {
    return {
      stdout,
      stderr: stderr + `\n[Timeout after ${timeout}ms]`,
      exitCode: 124,
    };
  }

  return { stdout, stderr, exitCode: await proc.exited };
}

/** Collect output for up to `ms` milliseconds without killing. */
async function collectWithTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  ms: number,
): Promise<{ stdout: string; stderr: string }> {
  const chunks: { out: string[]; err: string[] } = { out: [], err: [] };
  const decoder = new TextDecoder();

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    bucket: string[],
  ) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bucket.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream may error when we cancel — that's fine
    } finally {
      reader.releaseLock();
    }
  };

  // Start reading both streams
  const outP = readStream(proc.stdout as ReadableStream<Uint8Array>, chunks.out);
  const errP = readStream(proc.stderr as ReadableStream<Uint8Array>, chunks.err);

  // Wait for timeout, then return whatever we have
  await Promise.race([
    Promise.all([outP, errP]),
    new Promise<void>((r) => setTimeout(r, ms)),
  ]);

  // proc.unref() is not available on Bun.spawn, but the process
  // continues running since we never kill it.
  return {
    stdout: chunks.out.join(""),
    stderr: chunks.err.join(""),
  };
}

function cleanup(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore — file may already be gone
  }
}
