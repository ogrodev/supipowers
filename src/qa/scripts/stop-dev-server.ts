import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_SERVER_PID_FILENAME,
  killProcessTree,
  processExists,
} from "./dev-server-utils.js";

export interface StopDevServerResult {
  stopped: boolean;
  pid?: number;
  note?: string;
  error?: string;
}

function buildResult(result: StopDevServerResult): string {
  return JSON.stringify(result);
}

export async function stopDevServer(sessionDir: string): Promise<{ exitCode: number; output: string }> {
  const pidFile = path.join(sessionDir, DEV_SERVER_PID_FILENAME);
  if (!fs.existsSync(pidFile)) {
    return {
      exitCode: 0,
      output: buildResult({ stopped: false, error: "No PID file found" }),
    };
  }

  const pidText = fs.readFileSync(pidFile, "utf8").trim();
  if (pidText.length === 0) {
    return {
      exitCode: 0,
      output: buildResult({ stopped: false, error: "Empty PID file" }),
    };
  }

  const pid = Number.parseInt(pidText, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true });
    return {
      exitCode: 0,
      output: buildResult({ stopped: false, error: `Invalid PID file: ${pidText}` }),
    };
  }

  if (!processExists(pid)) {
    fs.rmSync(pidFile, { force: true });
    return {
      exitCode: 0,
      output: buildResult({
        stopped: true,
        pid,
        note: "Process was already dead",
      }),
    };
  }

  await killProcessTree(pid);
  fs.rmSync(pidFile, { force: true });
  return {
    exitCode: 0,
    output: buildResult({ stopped: true, pid }),
  };
}

async function main(): Promise<void> {
  const [sessionDir = "."] = process.argv.slice(2);
  const result = await stopDevServer(sessionDir);
  console.log(result.output);
  process.exit(result.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main();
}
