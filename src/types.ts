import type { TSchema } from "@sinclair/typebox";
import type { AgentSession, AgentSessionOptions, ExecOptions, ExecResult } from "./platform/types.js";

// src/types.ts — Shared type definitions for supipowers

/** Task complexity level */
export type TaskComplexity = "small" | "medium" | "large";

/** A single task in a plan */
export interface PlanTask {
  id: number;
  name: string;
  description: string;
  files: string[];
  criteria: string;
  complexity: TaskComplexity;
  /** Optional model override from [model: ...] annotation */
  model?: string;
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

/** Notification severity level */
export type NotificationLevel = "success" | "warning" | "error" | "info" | "summary";

/** Notification payload */
export interface Notification {
  level: NotificationLevel;
  title: string;
  detail?: string;
}

/** Canonical quality gate identifiers */
export type GateId = "lsp-diagnostics" | "test-suite" | "ai-review";

/** Aggregate gate execution status */
export type GateStatus = "passed" | "failed" | "skipped" | "blocked";

/** A single issue from a quality gate */
export interface GateIssue {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  detail?: string;
}

/** A single quality gate result */
export interface GateResult {
  gate: GateId;
  status: GateStatus;
  summary: string;
  issues: GateIssue[];
  metadata?: Record<string, unknown>;
}

/** Aggregate quality-gate summary */
export interface GateSummary {
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
}

/** Review report */
export interface ReviewReport {
  timestamp: string;
  selectedGates: GateId[];
  gates: GateResult[];
  summary: GateSummary;
  overallStatus: Exclude<GateStatus, "skipped">;
}

/** Config for the lsp-diagnostics gate */
export interface LspDiagnosticsGateConfig {
  enabled: boolean;
}

/** Config for the ai-review gate */
export interface AiReviewGateConfig {
  enabled: boolean;
  depth: "quick" | "deep";
}

/** Config for the test-suite gate */
export type TestSuiteGateConfig =
  | { enabled: false; command?: string | null }
  | { enabled: true; command: string };

/** Canonical quality gate config map */
export interface QualityGatesConfig {
  "lsp-diagnostics"?: LspDiagnosticsGateConfig;
  "ai-review"?: AiReviewGateConfig;
  "test-suite"?: TestSuiteGateConfig;
}

/** Gate filter options provided by commands */
export interface GateFilters {
  only?: GateId[];
  skip?: GateId[];
}

/** Project facts used by gate setup/detection */
export interface ProjectFacts {
  cwd: string;
  packageScripts: Record<string, string>;
  lockfiles: string[];
  activeTools: string[];
  existingGates: QualityGatesConfig;
}

/** Recommendation returned by gate auto-detection */
export interface GateDetectionResult<TConfig = unknown> {
  suggestedConfig: TConfig | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/** Shared runtime context passed to each gate */
export interface GateExecutionContext {
  cwd: string;
  changedFiles: string[];
  scopeFiles: string[];
  fileScope: "changed-files" | "all-files";
  exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
  execShell: (command: string, opts?: ExecOptions) => Promise<ExecResult>;
  getLspDiagnostics: (
    scopeFiles: string[],
    fileScope: GateExecutionContext["fileScope"]
  ) => Promise<GateIssue[]>;
  createAgentSession: (
    opts: Pick<AgentSessionOptions, "cwd" | "model" | "thinkingLevel">
  ) => Promise<AgentSession>;
  activeTools: string[];
  reviewModel?: Pick<ResolvedModel, "model" | "thinkingLevel">;
}

/** Registered quality gate contract */
export interface GateDefinition<TConfig> {
  id: GateId;
  description: string;
  configSchema: TSchema;
  detect(projectFacts: ProjectFacts): GateDetectionResult<TConfig> | null;
  run(context: GateExecutionContext, config: TConfig): Promise<GateResult>;
}

/** A proposed quality-gate configuration */
export interface SetupProposal {
  gates: QualityGatesConfig;
}

/** Result of running the setup flow */
export type SetupGatesResult =
  | { status: "proposed"; proposal: SetupProposal }
  | { status: "invalid"; proposal: SetupProposal; errors: string[] }
  | { status: "cancelled"; proposal?: SetupProposal; errors?: string[] };

// ── Release types ──────────────────────────────────────────

/** Semantic version bump type */
export type BumpType = "major" | "minor" | "patch";

/** Release channel target */
export type ReleaseChannel = "github" | "npm";

/** A single parsed commit entry */
export interface CommitEntry {
  hash: string;
  message: string;
  scope?: string;
  /** Original conventional commit prefix (feat, fix, refactor, etc.) */
  type?: string;
}

/** Commits categorized by conventional-commit type */
export interface CategorizedCommits {
  features: CommitEntry[];
  fixes: CommitEntry[];
  breaking: CommitEntry[];
  improvements: CommitEntry[];  // refactor, perf, revert
  maintenance: CommitEntry[];   // chore, ci, build, test, docs, style
  other: CommitEntry[];          // non-conventional only
}

/** Result of a release execution */
export interface ReleaseResult {
  version: string;
  channels: { channel: ReleaseChannel; success: boolean; error?: string }[];
  tagCreated: boolean;
  pushed: boolean;
  /** Human-readable error when the release fails before channel publishing */
  error?: string;
}

/** Context-mode integration settings */
export interface ContextModeConfig {
  /** Master toggle for all supi-context-mode integration (default: true) */
  enabled: boolean;
  /** Byte threshold above which tool results are compressed (default: 4096) */
  compressionThreshold: number;
  /** Block curl/wget/HTTP commands and redirect to ctx_fetch_and_index (default: true) */
  blockHttpCommands: boolean;
  /** Inject routing instructions into system prompt when ctx_* tools detected (default: true) */
  routingInstructions: boolean;
  /** Track events from tool results in SQLite (default: true) */
  eventTracking: boolean;
  /** Inject session knowledge into compaction summaries (default: true) */
  compaction: boolean;
  /** Use LLM calls for summarizing very large outputs (default: false) */
  llmSummarization: boolean;
  /** Byte threshold above which LLM summarization is used instead of structural compression (default: 16384) */
  llmThreshold: number;
  /** Hard-block native search/read tools when ctx_* equivalents are available (default: true) */
  enforceRouting: boolean;
}

/** MCP management settings */
export interface McpManagementConfig {
  /** Close mcpc sessions on agent shutdown (default: false) */
  closeSessionsOnExit: boolean;
}

/** Thinking level for model configuration */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A model assignment for an action or default */
export interface ModelAssignment {
  /** Concrete model ID: "claude-opus-4-6" or "provider/model-id" */
  model: string;
  /** Thinking level, null means inherit from model default */
  thinkingLevel: ThinkingLevel | null;
}

/** Persisted model configuration (model.json schema) */
export interface ModelConfig {
  version: string;
  default: ModelAssignment | null;
  actions: Record<string, ModelAssignment>;
}

/** Category of a model action */
export type ModelActionCategory = "command" | "sub-agent";

/** A registered model action (command or sub-agent role) */
export interface ModelAction {
  /** Unique key: "plan", "implementer", etc. */
  id: string;
  /** Whether this is a top-level command or a sub-agent role */
  category: ModelActionCategory;
  /** For sub-agents, the parent command ID (e.g. "run") */
  parent?: string;
  /** Display name for TUI */
  label: string;
  /** OMP role hint for tier 3 fallback: "default", "slow", "plan", etc. */
  harnessRoleHint?: string;
}

/** Result of model resolution with source tracking */
export type ModelSource = "action" | "default" | "harness-role" | "main";

export interface ResolvedModel {
  model: string | undefined;
  thinkingLevel: ThinkingLevel | null;
  source: ModelSource;
}

/** Config shape */
export interface SupipowersConfig {
  version: string;
  quality: {
    gates: QualityGatesConfig;
  };
  lsp: {
    setupGuide: boolean;
  };
  notifications: {
    verbosity: "quiet" | "normal" | "verbose";
  };
  qa: {
    framework: string | null;
    e2e: boolean;
  };
  release: {
    channels: ReleaseChannel[];
  };
  contextMode: ContextModeConfig;
  mcp: McpManagementConfig;
}
