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
export type RunStatus = "running" | "completed" | "paused" | "failed" | "cancelled";

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

/** Context-mode integration settings */
export interface ContextModeConfig {
  /** Master toggle for all context-mode integration (default: true) */
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
    e2e: boolean;
  };
  release: {
    pipeline: string | null;
  };
  contextMode: ContextModeConfig;
  mcp: McpManagementConfig;
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
