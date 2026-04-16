import * as fs from "node:fs";
import * as path from "node:path";
import type { PlatformPaths } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { createSession, generateSessionId, getSessionDir, updateSession } from "../storage/qa-sessions.js";
import type { E2ePhase, E2ePhaseStatus, E2eQaConfig, E2eSessionLedger } from "./types.js";

const PHASE_ORDER: E2ePhase[] = ["flow-discovery", "test-generation", "execution", "reporting"];

const PHASE_LABELS: Record<E2ePhase, string> = {
  "flow-discovery": "Discovery",
  "test-generation": "Generation",
  "execution": "Execution",
  "reporting": "Reporting",
};

/** Create a new E2E QA session with all phases pending */
export function createNewE2eSession(
  paths: PlatformPaths,
  cwd: string,
  config: E2eQaConfig,
  target?: WorkspaceTarget,
): E2eSessionLedger {
  const now = new Date().toISOString();
  const ledger: E2eSessionLedger = {
    id: generateSessionId(),
    createdAt: now,
    updatedAt: now,
    appType: config.app.type,
    baseUrl: config.app.baseUrl,
    phases: {
      "flow-discovery": { status: "pending" },
      "test-generation": { status: "pending" },
      "execution": { status: "pending" },
      "reporting": { status: "pending" },
    },
    flows: [],
    results: [],
    regressions: [],
    config,
  };

  createSession(paths, cwd, ledger, target);

  const sessionDir = getSessionDir(paths, cwd, ledger.id, target);
  fs.mkdirSync(path.join(sessionDir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "screenshots"), { recursive: true });

  return ledger;
}

/** Update a phase's status and timestamps, persist to disk */
export function advanceE2ePhase(
  paths: PlatformPaths,
  cwd: string,
  ledger: E2eSessionLedger,
  phase: E2ePhase,
  status: E2ePhaseStatus,
  target?: WorkspaceTarget,
): E2eSessionLedger {
  const now = new Date().toISOString();
  const record = { ...ledger.phases[phase] };

  record.status = status;
  if (status === "running" && !record.startedAt) {
    record.startedAt = now;
  }
  if (status === "completed" || status === "failed") {
    record.completedAt = now;
  }

  const updated: E2eSessionLedger = {
    ...ledger,
    updatedAt: now,
    phases: { ...ledger.phases, [phase]: record },
  };
  updateSession(paths, cwd, updated, target);
  return updated;
}

/** Get the next phase that is not completed */
export function getNextE2ePhase(ledger: E2eSessionLedger): E2ePhase | null {
  for (const phase of PHASE_ORDER) {
    if (ledger.phases[phase].status !== "completed") return phase;
  }
  return null;
}

/** Format phase status for TUI display */
export function getE2ePhaseStatusLine(ledger: E2eSessionLedger): string {
  return PHASE_ORDER.map((phase) => {
    const label = PHASE_LABELS[phase];
    const done = ledger.phases[phase].status === "completed";
    return done ? `[done] ${label}` : `[ ] ${label}`;
  }).join(" · ");
}
