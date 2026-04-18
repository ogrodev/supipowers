import * as fs from "node:fs";
import * as path from "node:path";
import type { FixPrSessionLedger } from "../fix-pr/types.js";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { getTargetStatePath } from "../workspace/state-paths.js";

const SESSIONS_DIR = "fix-pr-sessions";

function getBaseDir(paths: PlatformPaths, target: WorkspaceTarget): string {
  return getTargetStatePath(paths, target, SESSIONS_DIR);
}

export function getSessionDir(paths: PlatformPaths, target: WorkspaceTarget, sessionId: string): string {
  return path.join(getBaseDir(paths, target), sessionId);
}

export function generateFixPrSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `fpr-${date}-${time}-${rand}`;
}

export function createFixPrSession(paths: PlatformPaths, target: WorkspaceTarget, ledger: FixPrSessionLedger): void {
  const sessionDir = getSessionDir(paths, target, ledger.id);
  fs.mkdirSync(path.join(sessionDir, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "ledger.json"), JSON.stringify(ledger, null, 2));
}

export function loadFixPrSession(paths: PlatformPaths, target: WorkspaceTarget, sessionId: string): FixPrSessionLedger | null {
  const ledgerPath = path.join(getSessionDir(paths, target, sessionId), "ledger.json");
  if (!fs.existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, "utf-8")) as FixPrSessionLedger;
  } catch {
    return null;
  }
}

export function updateFixPrSession(paths: PlatformPaths, target: WorkspaceTarget, ledger: FixPrSessionLedger): void {
  const ledgerPath = path.join(getSessionDir(paths, target, ledger.id), "ledger.json");
  ledger.updatedAt = new Date().toISOString();
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

export function findActiveFixPrSession(
  paths: PlatformPaths,
  target: WorkspaceTarget,
  repo: string,
  prNumber: number,
): FixPrSessionLedger | null {
  const baseDir = getBaseDir(paths, target);
  if (!fs.existsSync(baseDir)) return null;

  const dirs = fs.readdirSync(baseDir)
    .filter((d) => d.startsWith("fpr-"))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const ledger = loadFixPrSession(paths, target, dir);
    if (ledger && ledger.status === "running" && ledger.repo === repo && ledger.prNumber === prNumber) return ledger;
  }
  return null;
}
