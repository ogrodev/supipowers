import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEV_SERVER_PID_FILENAME,
  getShellInvocation,
  isServerReachable,
  killProcessTree,
} from "./dev-server-utils.js";

export interface StartDevServerResult {
  pid: number | null;
  url: string;
  ready: boolean;
  note?: string;
  error?: string;
}

function buildResult(result: StartDevServerResult): string {
  return JSON.stringify(result);
}

export async function startDevServer(
  cwd: string,
  devCommand: string,
  port: number,
  timeoutSeconds: number,
  sessionDir: string,
): Promise<{ exitCode: number; output: string }> {
  const url = `http://localhost:${port}`;
  if (await isServerReachable(port)) {
    return {
      exitCode: 0,
      output: buildResult({
        pid: null,
        url,
        ready: true,
        note: "Server already running",
      }),
    };
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  const pidFile = path.join(sessionDir, DEV_SERVER_PID_FILENAME);
  const logPath = path.join(sessionDir, "dev-server.log");
  const logFd = fs.openSync(logPath, "a");
  const shell = getShellInvocation(devCommand);
  const child = spawn(shell.command, shell.args, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    return {
      exitCode: 1,
      output: buildResult({
        pid: null,
        url,
        ready: false,
        error: "Dev server failed to start",
      }),
    };
  }

  fs.writeFileSync(pidFile, String(child.pid));

  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    if (child.exitCode !== null) {
      fs.rmSync(pidFile, { force: true });
      return {
        exitCode: 1,
        output: buildResult({
          pid: child.pid,
          url,
          ready: false,
          error: "Server process exited",
        }),
      };
    }

    if (await isServerReachable(port)) {
      return {
        exitCode: 0,
        output: buildResult({
          pid: child.pid,
          url,
          ready: true,
        }),
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  await killProcessTree(child.pid);
  fs.rmSync(pidFile, { force: true });
  return {
    exitCode: 1,
    output: buildResult({
      pid: child.pid,
      url,
      ready: false,
      error: `Timeout after ${timeoutSeconds}s`,
    }),
  };
}

async function main(): Promise<void> {
  const [cwd, devCommand, portArg, timeoutArg = "60", sessionDir = "."] = process.argv.slice(2);
  const port = Number.parseInt(portArg ?? "", 10);
  const timeoutSeconds = Number.parseInt(timeoutArg, 10);

  if (!cwd || !devCommand || !Number.isInteger(port) || !Number.isInteger(timeoutSeconds)) {
    console.log(
      buildResult({
        pid: null,
        url: Number.isInteger(port) ? `http://localhost:${port}` : "http://localhost:0",
        ready: false,
        error: "Usage: start-dev-server.ts <cwd> <dev_command> <port> <timeout_seconds> <session_dir>",
      }),
    );
    process.exit(1);
  }

  const result = await startDevServer(cwd, devCommand, port, timeoutSeconds, sessionDir);
  console.log(result.output);
  process.exit(result.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main();
}
