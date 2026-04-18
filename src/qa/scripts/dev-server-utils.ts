import { spawnSync } from "node:child_process";
import { getShellInvocation } from "../../utils/shell.js";

export const DEV_SERVER_PID_FILENAME = "dev-server.pid";

const HEALTHCHECK_TIMEOUT_MS = 1_000;
const FORCE_KILL_WAIT_MS = 250;

export async function isServerReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await sleep(FORCE_KILL_WAIT_MS);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }

  await sleep(1_000);
  if (!processExists(pid)) {
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

export { getShellInvocation };
