import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { getTargetStatePath } from "../workspace/state-paths.js";
import type { E2eSessionLedger } from "../qa/types.js";

function getSessionsDir(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): string {
  if (target) {
    return getTargetStatePath(paths, target, "qa-sessions");
  }

  return paths.project(cwd, "qa-sessions");
}

export function getSessionDir(paths: PlatformPaths, cwd: string, sessionId: string, target?: WorkspaceTarget): string {
  return path.join(getSessionsDir(paths, cwd, target), sessionId);
}

/** Generate a unique QA session ID */
export function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `qa-${date}-${time}-${suffix}`;
}

/** Create a new QA session */
export function createSession(paths: PlatformPaths, cwd: string, ledger: E2eSessionLedger, target?: WorkspaceTarget): void {
  const sessionDir = getSessionDir(paths, cwd, ledger.id, target);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "ledger.json"),
    JSON.stringify(ledger, null, 2) + "\n",
  );
}

/** Load a QA session ledger */
export function loadSession(paths: PlatformPaths, cwd: string, sessionId: string, target?: WorkspaceTarget): E2eSessionLedger | null {
  const filePath = path.join(getSessionDir(paths, cwd, sessionId, target), "ledger.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Update a QA session ledger */
export function updateSession(paths: PlatformPaths, cwd: string, ledger: E2eSessionLedger, target?: WorkspaceTarget): void {
  const filePath = path.join(getSessionDir(paths, cwd, ledger.id, target), "ledger.json");
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2) + "\n");
}

/** List all QA sessions, newest first */
export function listSessions(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): string[] {
  const dir = getSessionsDir(paths, cwd, target);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("qa-"))
    .sort()
    .reverse();
}

/** Find the latest session with incomplete phases */
export function findActiveSession(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): E2eSessionLedger | null {
  for (const sessionId of listSessions(paths, cwd, target)) {
    const ledger = loadSession(paths, cwd, sessionId, target);
    if (!ledger) continue;
    const allCompleted = Object.values(ledger.phases).every(
      (p) => p.status === "completed",
    );
    if (!allCompleted) return ledger;
  }
  return null;
}

/** Find the latest session with failed test results */
export function findSessionWithFailures(paths: PlatformPaths, cwd: string, target?: WorkspaceTarget): E2eSessionLedger | null {
  for (const sessionId of listSessions(paths, cwd, target)) {
    const ledger = loadSession(paths, cwd, sessionId, target);
    if (!ledger) continue;
    if (ledger.results.some((r) => r.status === "fail")) return ledger;
  }
  return null;
}
