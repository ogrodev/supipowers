import * as fs from "node:fs";
import * as path from "node:path";
import type { FixPrSessionLedger } from "../fix-pr/types.js";

const SESSIONS_DIR = "fix-pr-sessions";

function getBaseDir(cwd: string): string {
  return path.join(cwd, ".omp", "supipowers", SESSIONS_DIR);
}

export function getSessionDir(cwd: string, sessionId: string): string {
  return path.join(getBaseDir(cwd), sessionId);
}

export function generateFixPrSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `fpr-${date}-${time}-${rand}`;
}

export function createFixPrSession(cwd: string, ledger: FixPrSessionLedger): void {
  const sessionDir = getSessionDir(cwd, ledger.id);
  fs.mkdirSync(path.join(sessionDir, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "ledger.json"), JSON.stringify(ledger, null, 2));
}

export function loadFixPrSession(cwd: string, sessionId: string): FixPrSessionLedger | null {
  const ledgerPath = path.join(getSessionDir(cwd, sessionId), "ledger.json");
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, "utf-8")) as FixPrSessionLedger;
  } catch {
    return null;
  }
}

export function updateFixPrSession(cwd: string, ledger: FixPrSessionLedger): void {
  const ledgerPath = path.join(getSessionDir(cwd, ledger.id), "ledger.json");
  ledger.updatedAt = new Date().toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

export function findActiveFixPrSession(cwd: string): FixPrSessionLedger | null {
  const baseDir = getBaseDir(cwd);
  if (!fs.existsSync(baseDir)) return null;

  const dirs = fs.readdirSync(baseDir)
    .filter((d) => d.startsWith("fpr-"))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const ledger = loadFixPrSession(cwd, dir);
    if (ledger && ledger.status === "running") return ledger;
  }
  return null;
}
