import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { VisualServerInfo, VisualEvent } from "./types.js";
import type { PlatformPaths } from "../platform/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Generate a unique visual session ID */
export function generateVisualSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `visual-${date}-${time}-${suffix}`;
}

/** Create the session directory and return its path */
export function createSessionDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  const sessionDir = paths.project(cwd, "visual", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

/** Write an HTML screen to the session directory */
export function writeScreen(sessionDir: string, filename: string, html: string): void {
  fs.writeFileSync(path.join(sessionDir, filename), html);
}

/** Read user events from the .events file */
export function readEvents(sessionDir: string): VisualEvent[] {
  const eventsFile = path.join(sessionDir, ".events");
  if (!fs.existsSync(eventsFile)) return [];

  const content = fs.readFileSync(eventsFile, "utf-8");
  const events: VisualEvent[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip invalid lines
    }
  }

  return events;
}

/** Clear the events file */
export function clearEvents(sessionDir: string): void {
  const eventsFile = path.join(sessionDir, ".events");
  if (fs.existsSync(eventsFile)) {
    fs.unlinkSync(eventsFile);
  }
}

/** Get the path to the scripts directory */
export function getScriptsDir(): string {
  return path.join(__dirname, "scripts");
}

/** Parse server info from start-server.sh JSON output */
export function parseServerInfo(stdout: string): VisualServerInfo | null {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.type === "server-started") {
        return {
          port: data.port,
          host: data.host,
          url: data.url,
          screenDir: data.screen_dir,
        };
      }
    } catch {
      // Skip non-JSON lines
    }
  }
  return null;
}

/** Check if a server is running for the given session dir */
export function isServerRunning(sessionDir: string): boolean {
  const pidFile = path.join(sessionDir, ".server.pid");
  if (!fs.existsSync(pidFile)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/** Read server info from .server-info file */
export function readServerInfo(sessionDir: string): VisualServerInfo | null {
  const infoFile = path.join(sessionDir, ".server-info");
  if (!fs.existsSync(infoFile)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(infoFile, "utf-8").trim());
    return {
      port: data.port,
      host: data.host,
      url: data.url,
      screenDir: data.screen_dir,
    };
  } catch {
    return null;
  }
}
