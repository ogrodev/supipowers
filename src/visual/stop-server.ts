import * as fs from "node:fs";
import * as path from "node:path";

export function stopVisualServer(sessionDir: string): { status: "stopped" | "not_running" } {
  const pidFile = path.join(sessionDir, ".server.pid");

  if (!fs.existsSync(pidFile)) {
    return { status: "not_running" };
  }

  const raw = fs.readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(raw, 10);

  if (isNaN(pid)) {
    // Corrupt PID file — clean up and treat as not running
    fs.rmSync(pidFile, { force: true });
    fs.rmSync(path.join(sessionDir, ".server-info"), { force: true });
    return { status: "not_running" };
  }

  try {
    process.kill(pid);
  } catch {
    // Process already dead (ESRCH) or permission error — proceed with cleanup
  }

  fs.rmSync(pidFile, { force: true });
  fs.rmSync(path.join(sessionDir, ".server.log"), { force: true });
  fs.rmSync(path.join(sessionDir, ".server-info"), { force: true });

  return { status: "stopped" };
}
