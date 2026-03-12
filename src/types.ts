// src/types.ts — Shared type definitions for supipowers

/** Sub-agent execution status */
export type AgentStatus = "done" | "done_with_concerns" | "blocked";

/** Task complexity level */
export type TaskComplexity = "small" | "medium" | "large";

/** Task parallelism annotation */
export type TaskParallelism =
  | { type: "parallel-safe" }
  | { type: "sequential"; dependsOn: number[] };

/** A single task in a plan */
export interface PlanTask {
  id: number;
  name: string;
  description: string;
  files: string[];
  criteria: string;
  complexity: TaskComplexity;
  parallelism: TaskParallelism;
}

/** A plan document (parsed from markdown) */
export interface Plan {
  name: string;
  created: string;
  tags: string[];
  context: string;
  tasks: PlanTask[];
  filePath: string;
}

/** Per-agent result stored after execution */
export interface AgentResult {
  taskId: number;
  status: AgentStatus;
  output: string;
  concerns?: string;
  filesChanged: string[];
  duration: number;
}

/** Batch status in a run */
export type BatchStatus = "pending" | "running" | "completed" | "failed";

/** A batch of tasks in a run */
export interface RunBatch {
  index: number;
  taskIds: number[];
  status: BatchStatus;
}

/** Overall run status */
export type RunStatus = "running" | "completed" | "paused" | "failed";

/** Run manifest stored on disk */
export interface RunManifest {
  id: string;
  planRef: string;
  profile: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  batches: RunBatch[];
}

/** Notification severity level */
export type NotificationLevel = "success" | "warning" | "error" | "info" | "summary";

/** Notification payload */
export interface Notification {
  level: NotificationLevel;
  title: string;
  detail?: string;
}

/** Quality gate result */
export interface GateResult {
  gate: string;
  passed: boolean;
  issues: GateIssue[];
}

/** A single issue from a quality gate */
export interface GateIssue {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
}

/** Review report */
export interface ReviewReport {
  profile: string;
  timestamp: string;
  gates: GateResult[];
  passed: boolean;
}

/** Config shape */
export interface SupipowersConfig {
  version: string;
  defaultProfile: string;
  orchestration: {
    maxParallelAgents: number;
    maxFixRetries: number;
    maxNestingDepth: number;
    modelPreference: string;
  };
  lsp: {
    setupGuide: boolean;
  };
  notifications: {
    verbosity: "quiet" | "normal" | "verbose";
  };
  qa: {
    framework: string | null;
    command: string | null;
  };
  release: {
    pipeline: string | null;
  };
}

// ── QA Session Management ──────────────────────────────────────────

/** QA pipeline phase */
export type QaPhase = "discovery" | "matrix" | "execution" | "reporting";

/** Phase completion status */
export type QaPhaseStatus = "pending" | "running" | "completed" | "failed";

/** Per-test result status */
export type TestResultStatus = "pass" | "fail" | "skip";

/** A discovered test case */
export interface QaTestCase {
  id: string;
  filePath: string;
  testName: string;
  suiteName?: string;
  tags?: string[];
}

/** Traceability matrix entry — one requirement mapped to its tests */
export interface QaMatrixEntry {
  requirement: string;
  testIds: string[];
  platforms?: string[];
  coverage: "full" | "partial" | "none";
}

/** Per-test execution result */
export interface QaTestResult {
  testId: string;
  status: TestResultStatus;
  duration?: number;
  error?: string;
  retryCount: number;
  lastRunAt: string;
}

/** Report summary generated in the Reporting phase */
export interface QaReportSummary {
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  failedTests: { testId: string; testName: string; error?: string }[];
  coverageSummary?: string;
}

/** Phase record within a session */
export interface QaPhaseRecord {
  status: QaPhaseStatus;
  startedAt?: string;
  completedAt?: string;
}

/** The full QA session ledger */
export interface QaSessionLedger {
  id: string;
  createdAt: string;
  updatedAt: string;
  framework: string;
  phases: Record<QaPhase, QaPhaseRecord>;
  tests: QaTestCase[];
  matrix: QaMatrixEntry[];
  results: QaTestResult[];
  report?: QaReportSummary;
}

/** Profile shape */
export interface Profile {
  name: string;
  gates: {
    lspDiagnostics: boolean;
    aiReview: { enabled: boolean; depth: "quick" | "deep" };
    codeQuality: boolean;
    testSuite: boolean;
    e2e: boolean;
  };
  orchestration: {
    reviewAfterEachBatch: boolean;
    finalReview: boolean;
  };
}
