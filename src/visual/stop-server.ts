import * as fs from "node:fs";
import * as path from "node:path";

export function stopVisualServer(
  sessionDir: string,
 ): { status: "stopped" | "not_running" | "failed" } {
  const pidFile = path.join(sessionDir, ".server.pid");

  if (!fs.existsSync(pidFile)) {
    return { status: "not_running" };
  }

  const raw = fs.readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(raw, 10);

  if (isNaN(pid)) {
    // Corrupt PID file — clean up and treat as not running
    cleanupServerArtifacts(sessionDir);
    return { status: "not_running" };
  }

  try {
    process.kill(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      return { status: "failed" };
    }
  }

  cleanupServerArtifacts(sessionDir);
  return { status: "stopped" };
}

function cleanupServerArtifacts(sessionDir: string): void {
  fs.rmSync(path.join(sessionDir, ".server.pid"), { force: true });
  fs.rmSync(path.join(sessionDir, ".server.log"), { force: true });
  fs.rmSync(path.join(sessionDir, ".server-info"), { force: true });
}
