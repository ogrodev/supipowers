import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { rmDirWithRetry } from "../../helpers/fs.js";

const START_RUNNER_PATH = path.resolve(import.meta.dir, "../../../src/qa/scripts/start-dev-server.ts");
const STOP_RUNNER_PATH = path.resolve(import.meta.dir, "../../../src/qa/scripts/stop-dev-server.ts");

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function isPortReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(500),
    });
    return true;
  } catch {
    return false;
  }
}

function runRunner(scriptPath: string, args: string[], cwd?: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      cwd,
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

describe("QA dev-server runners", () => {
  let tmpDir: string;
  let appDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-dev-server-"));
    appDir = path.join(tmpDir, "app");
    sessionDir = path.join(tmpDir, "session");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    runRunner(STOP_RUNNER_PATH, [sessionDir]);
    rmDirWithRetry(tmpDir);
  });

  test("starts a dev server, reports already-running state, then stops it", async () => {
    const port = await findFreePort();
    const serverScriptPath = path.join(appDir, "server.ts");
    fs.writeFileSync(
      serverScriptPath,
      [
        'import { createServer } from "node:http";',
        "const port = Number(process.argv[2]);",
        "const server = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
        "server.listen(port, '127.0.0.1');",
        "const shutdown = () => server.close(() => process.exit(0));",
        'process.on("SIGTERM", shutdown);',
        'process.on("SIGINT", shutdown);',
      ].join("\n"),
    );

    const devCommand = `"${process.execPath}" "${serverScriptPath}" ${port}`;

    const start = runRunner(
      START_RUNNER_PATH,
      [appDir, devCommand, String(port), "10", sessionDir],
      appDir,
    );

    expect(start.exitCode).toBe(0);
    const started = JSON.parse(start.stdout);
    expect(started.ready).toBe(true);
    expect(typeof started.pid).toBe("number");
    expect(fs.existsSync(path.join(sessionDir, "dev-server.pid"))).toBe(true);
    expect(await waitUntil(() => isPortReachable(port))).toBe(true);

    const startAgain = runRunner(
      START_RUNNER_PATH,
      [appDir, devCommand, String(port), "10", sessionDir],
      appDir,
    );

    expect(startAgain.exitCode).toBe(0);
    expect(JSON.parse(startAgain.stdout)).toEqual({
      pid: null,
      url: `http://localhost:${port}`,
      ready: true,
      note: "Server already running",
    });

    const stop = runRunner(STOP_RUNNER_PATH, [sessionDir], appDir);
    expect(stop.exitCode).toBe(0);
    const stopped = JSON.parse(stop.stdout);
    expect(stopped.stopped).toBe(true);
    expect(stopped.pid).toBe(started.pid);
    expect(fs.existsSync(path.join(sessionDir, "dev-server.pid"))).toBe(false);
    expect(await waitUntil(async () => !(await isPortReachable(port)))).toBe(true);
  });

  test("reports an error when the dev command exits before the server becomes ready", async () => {
    const port = await findFreePort();
    const exitScriptPath = path.join(appDir, "exit.ts");
    fs.writeFileSync(exitScriptPath, 'process.exit(0);\n');

    const devCommand = `"${process.execPath}" "${exitScriptPath}"`;

    const start = runRunner(
      START_RUNNER_PATH,
      [appDir, devCommand, String(port), "2", sessionDir],
      appDir,
    );

    expect(start.exitCode).toBe(1);
    expect(JSON.parse(start.stdout)).toMatchObject({
      ready: false,
      error: "Server process exited",
      url: `http://localhost:${port}`,
    });
  });
});
