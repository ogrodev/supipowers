import type { QaPhase, QaPhaseStatus, QaSessionLedger, QaTestCase, QaTestResult } from "../types.js";
import { generateSessionId, createSession, updateSession } from "../storage/qa-sessions.js";

const PHASE_ORDER: QaPhase[] = ["discovery", "matrix", "execution", "reporting"];

/** Create a new QA session with all phases pending */
export function createNewSession(cwd: string, framework: string): QaSessionLedger {
  const now = new Date().toISOString();
  const ledger: QaSessionLedger = {
    id: generateSessionId(),
    createdAt: now,
    updatedAt: now,
    framework,
    phases: {
      discovery: { status: "pending" },
      matrix: { status: "pending" },
      execution: { status: "pending" },
      reporting: { status: "pending" },
    },
    tests: [],
    matrix: [],
    results: [],
  };
  createSession(cwd, ledger);
  return ledger;
}

/** Update a phase's status and timestamps, persist to disk */
export function advancePhase(
  cwd: string,
  ledger: QaSessionLedger,
  phase: QaPhase,
  status: QaPhaseStatus
): QaSessionLedger {
  const now = new Date().toISOString();
  const record = { ...ledger.phases[phase] };

  record.status = status;
  if (status === "running" && !record.startedAt) {
    record.startedAt = now;
  }
  if (status === "completed" || status === "failed") {
    record.completedAt = now;
  }

  const updated: QaSessionLedger = {
    ...ledger,
    updatedAt: now,
    phases: { ...ledger.phases, [phase]: record },
  };
  updateSession(cwd, updated);
  return updated;
}

/** Merge new test results into the ledger, upserting by testId */
export function mergeTestResults(
  ledger: QaSessionLedger,
  newResults: QaTestResult[]
): QaSessionLedger {
  const resultMap = new Map(ledger.results.map((r) => [r.testId, r]));

  for (const incoming of newResults) {
    const existing = resultMap.get(incoming.testId);
    if (existing) {
      resultMap.set(incoming.testId, {
        ...incoming,
        retryCount: existing.retryCount + 1,
      });
    } else {
      resultMap.set(incoming.testId, incoming);
    }
  }

  return {
    ...ledger,
    updatedAt: new Date().toISOString(),
    results: Array.from(resultMap.values()),
  };
}

/** Get test cases whose latest result is "fail" */
export function getFailedTests(ledger: QaSessionLedger): QaTestCase[] {
  const failedIds = new Set(
    ledger.results.filter((r) => r.status === "fail").map((r) => r.testId)
  );
  return ledger.tests.filter((t) => failedIds.has(t.id));
}

/** Get the next phase that is not completed */
export function getNextPhase(ledger: QaSessionLedger): QaPhase | null {
  for (const phase of PHASE_ORDER) {
    if (ledger.phases[phase].status !== "completed") return phase;
  }
  return null;
}

/** Format phase status for TUI display */
export function getPhaseStatusLine(ledger: QaSessionLedger): string {
  return PHASE_ORDER.map((phase) => {
    const label = phase.charAt(0).toUpperCase() + phase.slice(1);
    const done = ledger.phases[phase].status === "completed";
    return done ? `[done] ${label}` : `[ ] ${label}`;
  }).join(" · ");
}
