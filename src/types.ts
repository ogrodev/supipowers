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
export type CommandGateId = "lint" | "typecheck" | "format" | "test-suite" | "build";
export type GateId = "lsp-diagnostics" | CommandGateId;

export type ConfigScope = "global" | "root" | "workspace";

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

/** AI review pipeline levels */
export type ReviewLevel = "quick" | "deep" | "multi-agent";

/** Scope selection modes for /supi:review */
export type ReviewScopeMode = "pull-request" | "uncommitted" | "commit" | "custom";

/** Structured review output status */
export type ReviewOutputStatus = "passed" | "failed" | "blocked";

/** Review finding severity */
export type ReviewFindingSeverity = "error" | "warning" | "info";

/** Prioritization tier for review findings */
export type ReviewFindingPriority = "P0" | "P1" | "P2" | "P3";

/** Validation verdict for a review finding */
export type ReviewValidationVerdict = "confirmed" | "rejected" | "uncertain";

/** Review session lifecycle status */
export type ReviewSessionStatus = "running" | "completed" | "blocked" | "cancelled";

/** User decision after reviewing consolidated/current findings */
export type ReviewPostConsolidationAction =
  | "fix-now"
  | "document-only"
  | "discuss-before-fixing";

/** File-level diff summary within a review scope */
export interface ReviewScopeFile {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
}

/** Aggregate statistics for a review scope */
export interface ReviewScopeStats {
  filesChanged: number;
  excludedFiles: number;
  additions: number;
  deletions: number;
}

/** Review scope selected by the command pipeline */
export interface ReviewScope {
  mode: ReviewScopeMode;
  description: string;
  diff: string;
  files: ReviewScopeFile[];
  stats: ReviewScopeStats;
  baseBranch?: string;
  commit?: string;
  customInstructions?: string;
}

/** Per-finding validation metadata */
export interface ReviewFindingValidation {
  verdict: ReviewValidationVerdict;
  reasoning: string;
  validatedBy: string;
  validatedAt: string;
}

/** Canonical review finding produced by AI reviewers */
export interface ReviewFinding {
  id: string;
  title: string;
  severity: ReviewFindingSeverity;
  priority: ReviewFindingPriority;
  confidence: number;
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  suggestion: string | null;
  agent?: string;
  validation?: ReviewFindingValidation;
}

/** Structured output returned by review agents */
export interface ReviewOutput {
  findings: ReviewFinding[];
  summary: string;
  status: ReviewOutputStatus;
}

/** Config entry for one review agent */
export interface ReviewAgentConfig {
  name: string;
  enabled: boolean;
  data: string;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
}

/** Top-level review agent pipeline config */
export interface ReviewAgentsConfig {
  agents: ReviewAgentConfig[];
}

/** Loaded review agent definition from markdown frontmatter + prompt body */
export interface ReviewAgentDefinition {
  name: string;
  description: string;
  focus: string | null;
  prompt: string;
  filePath: string;
}
/** Review agent definition combined with pipeline config */
export interface ConfiguredReviewAgent extends ReviewAgentDefinition {
  enabled: boolean;
  data: string;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  scope?: "global" | "root" | "workspace";
}



/** Persisted summary for one review iteration */
export interface ReviewIterationSummary {
  iteration: number;
  findings: number;
  status: ReviewOutputStatus;
  file: string;
  createdAt: string;
}
/** Aggregate status of an auto-fix pass */
export type ReviewFixOutputStatus = "applied" | "partial" | "skipped" | "blocked";

/** Structured result returned by the review fixer */
export interface ReviewFixOutput {
  fixes: ReviewFixRecord[];
  summary: string;
  status: ReviewFixOutputStatus;
}



/** Persisted auto-fix attempt */
export interface ReviewFixRecord {
  findingIds: string[];
  file: string | null;
  status: "applied" | "skipped" | "failed";
  summary: string;
}

/** Paths to persisted review session artifacts */
export interface ReviewSessionArtifacts {
  scope: string;
  iterationsDir: string;
  agentsDir: string;
  rawFindings?: string;
  validatedFindings?: string;
  consolidatedFindings?: string;
  findingsReport?: string;
}

/** Persisted /supi:review session metadata */
export interface ReviewSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  level: ReviewLevel;
  status: ReviewSessionStatus;
  scope: ReviewScope;
  validateFindings: boolean;
  consolidate: boolean;
  postConsolidationAction: ReviewPostConsolidationAction | null;
  maxIterations: number;
  currentIteration: number;
  iterations: ReviewIterationSummary[];
  fixes: ReviewFixRecord[];
  artifacts: ReviewSessionArtifacts;
  agents: string[];
}


/** Config for the lsp-diagnostics gate */
export interface LspDiagnosticsGateConfig {
  enabled: boolean;
}

/** Shared config for command-driven gates. */
export type CommandGateConfig =
  | { enabled: false; command?: string | null }
  | { enabled: true; command: string };

export type LintGateConfig = CommandGateConfig;
export type TypecheckGateConfig = CommandGateConfig;
export type FormatGateConfig = CommandGateConfig;
export type TestSuiteGateConfig = CommandGateConfig;
export type BuildGateConfig = CommandGateConfig;

/** Canonical quality gate config map */
export interface QualityGatesConfig {
  "lsp-diagnostics"?: LspDiagnosticsGateConfig;
  "lint"?: LintGateConfig;
  "typecheck"?: TypecheckGateConfig;
  "format"?: FormatGateConfig;
  "test-suite"?: TestSuiteGateConfig;
  "build"?: BuildGateConfig;
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

/** Release channel target (built-in IDs or user-defined custom channel IDs) */
export type ReleaseChannel = string;

/** Supported package managers for workspace-aware execution */
export type PackageManagerId = "bun" | "npm" | "pnpm" | "yarn";

/** Workspace target kind */
export type WorkspaceTargetKind = "root" | "workspace";

/** One package target discovered in the current repository */
export interface WorkspaceTarget {
  id: string;
  name: string;
  kind: WorkspaceTargetKind;
  repoRoot: string;
  packageDir: string;
  manifestPath: string;
  relativeDir: string;
  version: string;
  private: boolean;
  packageManager: PackageManagerId;
}

/** One releasable package discovered in the current repository */
export interface ReleaseTarget extends WorkspaceTarget {
  publishScopePaths: string[];
  defaultTagFormat: string;
}

/** User-defined custom release channel configuration */
export interface CustomChannelConfig {
  /** Display name shown in the channel selection UI */
  label: string;
  /** Shell command template with ${tag}, ${version}, ${changelog} placeholders */
  publishCommand: string;
  /** Shell command to detect availability — exit code 0 means available. When omitted, always available. */
  detectCommand?: string;
}

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
  qa: {
    framework: string | null;
    e2e: boolean;
  };
  release: {
    channels: ReleaseChannel[];
    /** Tag format template. Use ${version} as placeholder. Default: "v${version}" */
    tagFormat: string;
    /** User-defined custom release channels keyed by channel ID */
    customChannels: Record<string, CustomChannelConfig>;
  };
  contextMode: ContextModeConfig;
  mcp: McpManagementConfig;
}


/** Persisted state for /supi:generate docs — tracks which docs are monitored and the last checked commit */
export interface DocDriftState {
  trackedFiles: string[];
  lastCommit: string | null;
  lastRunAt: string | null;
}

/** A single drift finding from a sub-agent doc review */
export interface DriftFinding {
  file: string;
  description: string;
  severity: "info" | "warning" | "error";
  relatedFiles?: string[];
}

/** Result of a headless doc-drift check (multi-agent pipeline) */
export interface DriftCheckResult {
  drifted: boolean;
  summary: string;
  findings: DriftFinding[];
}