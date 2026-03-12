import * as fs from "node:fs";
import * as path from "node:path";
import type { E2eSessionLedger } from "../qa/types.js";

const SESSIONS_DIR = [".omp", "supipowers", "qa-sessions"];

function getSessionsDir(cwd: string): string {
  return path.join(cwd, ...SESSIONS_DIR);
}

export function getSessionDir(cwd: string, sessionId: string): string {
  return path.join(getSessionsDir(cwd), sessionId);
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
export function createSession(cwd: string, ledger: E2eSessionLedger): void {
  const sessionDir = getSessionDir(cwd, ledger.id);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "ledger.json"),
    JSON.stringify(ledger, null, 2) + "\n",
  );
}

/** Load a QA session ledger */
export function loadSession(cwd: string, sessionId: string): E2eSessionLedger | null {
  const filePath = path.join(getSessionDir(cwd, sessionId), "ledger.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Update a QA session ledger */
export function updateSession(cwd: string, ledger: E2eSessionLedger): void {
  const filePath = path.join(getSessionDir(cwd, ledger.id), "ledger.json");
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2) + "\n");
}

/** List all QA sessions, newest first */
export function listSessions(cwd: string): string[] {
  const dir = getSessionsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("qa-"))
    .sort()
    .reverse();
}

/** Find the latest session with incomplete phases */
export function findActiveSession(cwd: string): E2eSessionLedger | null {
  for (const sessionId of listSessions(cwd)) {
    const ledger = loadSession(cwd, sessionId);
    if (!ledger) continue;
    const allCompleted = Object.values(ledger.phases).every(
      (p) => p.status === "completed",
    );
    if (!allCompleted) return ledger;
  }
  return null;
}

/** Find the latest session with failed test results */
export function findSessionWithFailures(cwd: string): E2eSessionLedger | null {
  for (const sessionId of listSessions(cwd)) {
    const ledger = loadSession(cwd, sessionId);
    if (!ledger) continue;
    if (ledger.results.some((r) => r.status === "fail")) return ledger;
  }
  return null;
}
