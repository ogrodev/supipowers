export type QaSeverity = "high" | "medium" | "low";

export interface QaTestCase {
  id: string;
  title: string;
  objective: string;
  expected: string;
  severity: QaSeverity;
  commandLines: string[];
}

export interface QaMatrix {
  workflow: string;
  targetUrl: string;
  generatedAt: string;
  cases: QaTestCase[];
  contextNotes?: string;
}

export interface QaCaseResult {
  caseId: string;
  title: string;
  severity: QaSeverity;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
  screenshots: string[];
  commands: Array<{
    line: string;
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

export type QaVerdict = "APPROVE" | "REFUSE" | "PENDING_DECISION";

export interface QaExecutionSummary {
  runId: string;
  workflow: string;
  targetUrl: string;
  unstablePhaseWarning?: string;
  recommendation: Exclude<QaVerdict, "PENDING_DECISION">;
  finalVerdict: QaVerdict;
  startedAt: string;
  finishedAt: string;
  matrix: QaMatrix;
  results: QaCaseResult[];
  notesFilePath: string;
}

export interface QaAuthProfile {
  targetUrl: string;
  authSetupCommands: string[];
  updatedAt: number;
}
