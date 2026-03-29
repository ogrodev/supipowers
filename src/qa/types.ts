// ── App Detection ──────────────────────────────────────────────────

export type AppType = "nextjs-app" | "nextjs-pages" | "react-router" | "vite" | "express" | "generic";

export interface AppTypeInfo {
  type: AppType;
  devCommand: string;
  port: number;
  baseUrl: string;
}

// ── Configuration ──────────────────────────────────────────────────

export interface PlaywrightConfig {
  headless: boolean;
  timeout: number;
}

export interface ExecutionConfig {
  maxRetries: number;
  maxFlows: number;
}

export interface E2eQaConfig {
  app: AppTypeInfo;
  playwright: PlaywrightConfig;
  execution: ExecutionConfig;
}

// ── Persistent Flow Matrix ─────────────────────────────────────────

export interface E2eFlowRecord {
  id: string;
  name: string;
  entryRoute: string;
  steps: string[];
  priority: "critical" | "high" | "medium" | "low";
  lastStatus: "pass" | "fail" | "untested";
  lastTestedAt: string | null;
  lastError?: string;
  addedAt: string;
  removedAt?: string;
}

export interface E2eMatrix {
  version: string;
  updatedAt: string;
  appType: string;
  flows: E2eFlowRecord[];
}

// ── Session ────────────────────────────────────────────────────────

export type E2ePhase = "flow-discovery" | "test-generation" | "execution" | "reporting";
export type E2ePhaseStatus = "pending" | "running" | "completed" | "failed";

export interface E2eFlow {
  id: string;
  name: string;
  entryRoute: string;
  steps: string[];
  priority: "critical" | "high" | "medium" | "low";
  testFile?: string;
}

export interface E2eTestResult {
  flowId: string;
  testFile: string;
  status: "pass" | "fail" | "skip";
  duration?: number;
  error?: string;
  screenshot?: string;
  retryCount: number;
}

export interface E2eRegression {
  flowId: string;
  flowName: string;
  previousStatus: "pass";
  currentStatus: "fail";
  error: string;
  resolution?: "bug" | "intentional-change" | "skipped";
}

export interface E2eSessionLedger {
  id: string;
  createdAt: string;
  updatedAt: string;
  appType: string;
  baseUrl: string;
  phases: Record<E2ePhase, { status: E2ePhaseStatus; startedAt?: string; completedAt?: string }>;
  flows: E2eFlow[];
  results: E2eTestResult[];
  regressions: E2eRegression[];
  config: E2eQaConfig;
}
