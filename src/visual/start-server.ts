import * as fs from "node:fs";
import * as path from "node:path";
import { getScriptsDir, readServerInfo } from "./companion.js";
import { stopVisualServer } from "./stop-server.js";
import type { VisualServerInfo } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const START_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

interface StartServerOptions {
  sessionDir: string;
  port?: number;
  host?: string;
  urlHost?: string;
}
/** Start the visual companion server and wait for its connection info. */
export async function startVisualServer(opts: StartServerOptions): Promise<VisualServerInfo | null> {
  const host = opts.host ?? DEFAULT_HOST;
  const urlHost = opts.urlHost ?? deriveUrlHost(host);
  const scriptsDir = getScriptsDir();
  const pidFile = path.join(opts.sessionDir, ".server.pid");

  fs.mkdirSync(opts.sessionDir, { recursive: true });
  stopVisualServer(opts.sessionDir);
  cleanupStartupArtifacts(opts.sessionDir);

  try {
    const subprocess = Bun.spawn(["node", "index.js"], {
      cwd: scriptsDir,
      env: {
        ...process.env,
        SUPI_VISUAL_DIR: opts.sessionDir,
        SUPI_VISUAL_PORT: opts.port !== undefined ? String(opts.port) : undefined,
        SUPI_VISUAL_HOST: host,
        SUPI_VISUAL_URL_HOST: urlHost,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });

    subprocess.unref();
    fs.writeFileSync(pidFile, String(subprocess.pid));

    const serverInfo = await pollForServerStart(opts.sessionDir, subprocess.pid, START_TIMEOUT_MS);
    if (serverInfo) {
      return serverInfo;
    }

    stopVisualServer(opts.sessionDir);
    // stopVisualServer may leave artifacts when kill returns a non-ESRCH error;
    // force-clean so the caller never inherits stale state.
    fs.rmSync(pidFile, { force: true });
    cleanupStartupArtifacts(opts.sessionDir);
    return null;
  } catch {
    fs.rmSync(pidFile, { force: true });
    return null;
  }
}

function deriveUrlHost(host: string): string {
  return host === "127.0.0.1" || host === "localhost" ? "localhost" : host;
}

function cleanupStartupArtifacts(sessionDir: string): void {
  fs.rmSync(path.join(sessionDir, ".server-info"), { force: true });
}

async function pollForServerStart(
  sessionDir: string,
  pid: number,
  timeoutMs: number,
): Promise<VisualServerInfo | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const serverInfo = readServerInfo(sessionDir);
    if (serverInfo) {
      return isProcessAlive(pid) ? serverInfo : null;
    }

    if (!isProcessAlive(pid)) {
      return null;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
