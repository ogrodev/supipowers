import * as fs from "node:fs";
import * as path from "node:path";
import type { FixPrSessionLedger } from "../fix-pr/types.js";
import type { PlatformPaths } from "../platform/types.js";

const SESSIONS_DIR = "fix-pr-sessions";

function getBaseDir(paths: PlatformPaths, cwd: string): string {
  return paths.project(cwd, SESSIONS_DIR);
}

export function getSessionDir(paths: PlatformPaths, cwd: string, sessionId: string): string {
  return path.join(getBaseDir(paths, cwd), sessionId);
}

export function generateFixPrSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `fpr-${date}-${time}-${rand}`;
}

export function createFixPrSession(paths: PlatformPaths, cwd: string, ledger: FixPrSessionLedger): void {
  const sessionDir = getSessionDir(paths, cwd, ledger.id);
  fs.mkdirSync(path.join(sessionDir, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "ledger.json"), JSON.stringify(ledger, null, 2));
}

export function loadFixPrSession(paths: PlatformPaths, cwd: string, sessionId: string): FixPrSessionLedger | null {
  const ledgerPath = path.join(getSessionDir(paths, cwd, sessionId), "ledger.json");
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, "utf-8")) as FixPrSessionLedger;
  } catch {
    return null;
  }
}

export function updateFixPrSession(paths: PlatformPaths, cwd: string, ledger: FixPrSessionLedger): void {
  const ledgerPath = path.join(getSessionDir(paths, cwd, ledger.id), "ledger.json");
  ledger.updatedAt = new Date().toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

export function findActiveFixPrSession(paths: PlatformPaths, cwd: string): FixPrSessionLedger | null {
  const baseDir = getBaseDir(paths, cwd);
  if (!fs.existsSync(baseDir)) return null;

  const dirs = fs.readdirSync(baseDir)
    .filter((d) => d.startsWith("fpr-"))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const ledger = loadFixPrSession(paths, cwd, dir);
    if (ledger && ledger.status === "running") return ledger;
  }
  return null;
}
