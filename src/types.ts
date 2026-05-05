import type { TSchema } from "@sinclair/typebox";
import type { AgentSession, AgentSessionOptions, ExecOptions, ExecResult } from "./platform/types.js";


/** Generic schema-validation error produced by src/ai/structured-output.ts */
export interface ValidationError {
  path: string;
  message: string;
}
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

export type ConfigScope = "global" | "root";

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
  /** Opt this agent into IRC peer coordination (requires OMP `irc` tool active). */
  peerCoordination?: boolean;
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
  /** Opt this agent into IRC peer coordination (requires OMP `irc` tool active). */
  peerCoordination?: boolean;
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

/** Canonical target selectors for command-driven quality-gate runs. */
export type CommandGateRunTarget =
  | { scope: "all-targets" }
  | { scope: "root" }
  | { scope: "all-workspaces" }
  | { scope: "workspace"; relativeDir: string };

export interface CommandGateRun {
  command: string;
  target: CommandGateRunTarget;
}

/** Shared config for command-driven gates. */
export type CommandGateConfig =
  | { enabled: false }
  | { enabled: true; runs: CommandGateRun[] };

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

/** Per-target facts used by monorepo-aware gate setup/detection */
export interface ProjectFactsTarget {
  name: string;
  kind: WorkspaceTargetKind;
  relativeDir: string;
  packageScripts: Record<string, string>;
}

/** Project facts used by gate setup/detection */
export interface ProjectFacts {
  cwd: string;
  /** Scripts that are shared across every discovered target and are safe baseline candidates. */
  packageScripts: Record<string, string>;
  lockfiles: string[];
  activeTools: string[];
  existingGates: QualityGatesConfig;
  /** Detailed per-target scripts for AI-assisted setup in monorepos. */
  targets: ProjectFactsTarget[];
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
  target: WorkspaceTarget;
  exec: (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
  execShell: (command: string, opts?: ExecOptions) => Promise<ExecResult>;
  getLspDiagnostics: (
    scopeFiles: string[],
    fileScope: GateExecutionContext["fileScope"]
  ) => Promise<GateIssue[]>;
  createAgentSession: (
    opts: Pick<AgentSessionOptions, "cwd" | "model" | "thinkingLevel" | "agentId" | "agentDisplayName">
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
  notes?: string[];
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

export type ContextModeProcessorFamily =
  | "git"
  | "test"
  | "lint"
  | "build"
  | "k8s"
  | "docker"
  | "log"
  | "json";

export interface ContextModeProcessorsConfig {
  enabled: boolean;
  disable: ContextModeProcessorFamily[];
}

export type ContextModeLazyToolsMode = "conservative" | "balanced" | "aggressive";

export interface ContextModeLazyToolsConfig {
  enabled: boolean;
  mode: ContextModeLazyToolsMode;
  alwaysKeep: string[];
  commandAllowlist: Record<string, string[]>;
  keywordTools: Record<string, string[]>;
}

export type KnowledgeOwnerScope = "session" | "project" | "legacy";

export interface KnowledgeOwner {
  ownerScope: KnowledgeOwnerScope;
  ownerId?: string;
}

export interface ContextModeCacheHandlesConfig {
  enabled: boolean;
  spillThresholdBytes: number;
  previewBytes: number;
}

export interface ContextModeRepomapConfig {
  enabled: boolean;
  tokenBudget: number;
  maxFiles: number;
}

export interface ContextModeMemoryConfig {
  enabled: boolean;
  byteBudget: number;
  maxRows: number;
  retentionDays: number;
  /**
   * Cadence at which the focus-chain block is reinjected into the system
   * prompt at `before_agent_start`. Turn 1 always injects; subsequent turns
   * inject only when `turnCount % focusChainCadence === 0`. Default 6
   * (matches Cline v3.25). Must be >= 1.
   */
  focusChainCadence: number;
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
  /** Deterministic content-aware emission processors (default: enabled with no disabled families) */
  processors: ContextModeProcessorsConfig;
  /** Lazy active-tool filtering policy for supipowers-owned tools (default: balanced) */
  lazyTools: ContextModeLazyToolsConfig;
  /** Cache-handle spill policy for oversized current tool results (default: enabled at 50KiB) */
  cacheHandles: ContextModeCacheHandlesConfig;
  /** Repo-map retrieval policy for ctx_repomap */
  repomap: ContextModeRepomapConfig;
  /** Cross-session memory injection policy */
  memory: ContextModeMemoryConfig;
}

/** MCP management settings */
export interface McpManagementConfig {
  /** Close mcpc sessions on agent shutdown (default: false) */
  closeSessionsOnExit: boolean;
}

/** MemPalace native integration default wing derivation mode */
export type MempalaceWingStrategy = "repo-name" | "project-slug" | "explicit";

/** MemPalace native integration settings */
export interface MempalaceConfig {
  /** Enable native MemPalace memory integration */
  enabled: boolean;
  /** Exact PyPI package version installed by managed setup */
  packageVersion: string;
  /** Managed Python virtual environment path; supports ~ expansion */
  managedVenvPath: string;
  /** MemPalace palace path; supports ~ expansion */
  palacePath: string;
  /** How to derive the default project wing */
  defaultWingStrategy: MempalaceWingStrategy;
  /** Required non-empty wing when defaultWingStrategy is explicit */
  explicitWing: string | null;
  /** Agent name used for diary/checkpoint metadata */
  defaultAgentName: string;
  /** Permit explicit tool calls to setup automatically before dispatch */
  autoSetup: boolean;
  hooks: {
    wakeUp: boolean;
    searchGuidance: boolean;
    compactionCheckpoint: boolean;
    shutdownDiary: boolean;
  };
  budgets: {
    wakeUpTokens: number;
    searchResultChars: number;
    listResultChars: number;
    diaryChars: number;
  };
  timeouts: {
    setupMs: number;
    bridgeMs: number;
    hookMs: number;
  };
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
  ultraplan: UltraPlanConfig;
  contextMode: ContextModeConfig;
  mcp: McpManagementConfig;
  mempalace: MempalaceConfig;
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
  /** Error messages from sub-agents whose output failed schema validation after retries. */
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Reliability metrics (Phase 8 — observability + failure mining)
// ---------------------------------------------------------------------------

/** Outcome categories for AI-heavy command attempts. */
export type ReliabilityOutcome = "ok" | "blocked" | "retry-exhausted" | "fallback" | "agent-error";

/** A single recorded outcome from an AI-heavy workflow attempt. */
export interface ReliabilityRecord {
  /** ISO timestamp the attempt completed. */
  ts: string;
  /** Logical command name (e.g. "plan", "commit", "review", "fix-pr", "release"). */
  command: string;
  /** Specific operation within the command (e.g. "plan-spec", "commit-plan", "polish"). Optional. */
  operation?: string;
  /** Final outcome category. */
  outcome: ReliabilityOutcome;
  /** Number of attempts the underlying retry loop performed. */
  attempts: number;
  /** Short truthful reason on blocked/error outcomes. Optional on success. */
  reason?: string;
  /** Optional cwd where the attempt ran. */
  cwd?: string;
}

/** Aggregated summary of reliability records, suitable for status/doctor output. */
export interface ReliabilitySummary {
  command: string;
  total: number;
  /** Count by outcome category. */
  byOutcome: Record<ReliabilityOutcome, number>;
  /** Average attempts across all records (0 when total is 0). */
  avgAttempts: number;
  /** Most recent record timestamp, or null when empty. */
  lastRecordedAt: string | null;
}

// ---------------------------------------------------------------------------
// Ultraplan (Phase 1 substrate)
// ---------------------------------------------------------------------------

export type UltraPlanStackId = "frontend" | "backend" | "infrastructure";
export type UltraPlanScenarioLevel = "unit" | "integration" | "e2e";
export type UltraPlanApplicability = "applicable" | "not-applicable";
export type UltraPlanSessionState = "ready" | "running" | "blocked" | "awaiting-user" | "complete" | "discarded";
export type UltraPlanSessionBucket = "pending" | "ongoing" | "idle" | "done";
export type UltraPlanScenarioStatus =
  | "planned"
  | "red-running"
  | "red-proved"
  | "green-running"
  | "green-proved"
  | "in-review"
  | "review-passed"
  | "blocked"
  | "done";
export type UltraPlanReviewStatus = "pending" | "running" | "passed" | "failed" | "blocked";
export type UltraPlanExecutionPhase = "red" | "green" | "review" | "waiting" | "complete";
export type UltraPlanCursorTargetType = "scenario" | "domain-review" | "stack-review" | "session";
export type UltraPlanCursorStatus = UltraPlanScenarioStatus | UltraPlanReviewStatus | UltraPlanSessionState;
export type UltraPlanAgentType = "built-in" | "named";
export type UltraPlanAgentSlotName =
  | "frontend-executor"
  | "frontend-tester"
  | "frontend-domain-reviewer"
  | "frontend-stack-reviewer"
  | "backend-executor"
  | "backend-tester"
  | "backend-domain-reviewer"
  | "backend-stack-reviewer"
  | "infrastructure-executor"
  | "infrastructure-tester"
  | "infrastructure-domain-reviewer"
  | "infrastructure-stack-reviewer";
export type UltraPlanReviewerSlotName = Extract<
  UltraPlanAgentSlotName,
  `${UltraPlanStackId}-domain-reviewer` | `${UltraPlanStackId}-stack-reviewer`
>;
export type UltraPlanSlotOverride = {
  agentName?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
};
export interface UltraPlanReviewGatePolicy {
  enabled: boolean;
}
export interface UltraPlanConfig {
  slots: Partial<Record<UltraPlanAgentSlotName, UltraPlanSlotOverride>>;
  reviewGates: Partial<Record<UltraPlanReviewerSlotName, UltraPlanReviewGatePolicy>>;
}
export interface UltraPlanAgentDefinitionFrontmatter {
  name: string;
  description: string;
  supportedSlots: UltraPlanAgentSlotName[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  focus?: string;
}

export type UltraPlanAgentDefinitionSource = "built-in" | "global";
export interface UltraPlanAgentDefinition extends UltraPlanAgentDefinitionFrontmatter {
  prompt: string;
  filePath: string;
  source: UltraPlanAgentDefinitionSource;
}

export type UltraPlanSelectionSource = "default" | "project";
export type UltraPlanResolvedValueSource = "project" | "global" | "built-in" | "unset";
export interface ResolvedUltraPlanSlotBinding {
  slot: UltraPlanAgentSlotName;
  agentType: UltraPlanAgentType;
  agentName: string;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  selectionSource: UltraPlanSelectionSource;
  definitionSource: UltraPlanAgentDefinitionSource;
  modelSource: UltraPlanResolvedValueSource;
  thinkingLevelSource: UltraPlanResolvedValueSource;
  definitionPath: string | null;
}

export interface ResolvedUltraPlanCatalog {
  slots: Record<UltraPlanAgentSlotName, ResolvedUltraPlanSlotBinding | null>;
  reviewGates: Partial<Record<UltraPlanReviewerSlotName, UltraPlanReviewGatePolicy>>;
}
export type UltraPlanCatalogErrorCode =
  | "missing-built-in-definition"
  | "required-slot-unresolved"
  | "unsupported-slot"
  | "invalid-agent-definition"
  | "duplicate-agent-name"
  | "reserved-agent-name"
  | "invalid-config"
  | "catalog-io";

export interface UltraPlanCatalogError {
  slot: UltraPlanAgentSlotName | null;
  code: UltraPlanCatalogErrorCode;
  message: string;
  path: string | null;
}

export type UltraPlanCatalogLoadResult =
  | { ok: true; value: ResolvedUltraPlanCatalog }
  | { ok: false; value: ResolvedUltraPlanCatalog; errors: UltraPlanCatalogError[] };




export type UltraPlanProofType = "test" | "command" | "review" | "artifact";
export type UltraPlanBlockerScope = "session" | "stack" | "domain" | "scenario";
export type UltraPlanRecoveryMode = "retry" | "await-user" | "manual";

export interface UltraPlanProgressSummary {
  total: number;
  terminal: number;
  blocked: number;
}

export interface UltraPlanAffectedUnitRef {
  stack: UltraPlanStackId | null;
  domainId: string | null;
  level: UltraPlanScenarioLevel | null;
  scenarioId: string | null;
}

export interface UltraPlanProofEvidence {
  summary: string;
  command?: string;
  outputRef?: string;
  metadata?: Record<string, unknown>;
}

export interface UltraPlanProof {
  type: UltraPlanProofType;
  phase: UltraPlanExecutionPhase;
  recordedAt: string;
  actor: string;
  evidence: UltraPlanProofEvidence;
  artifactRef: string;
}

export interface UltraPlanBlocker {
  code: string;
  message: string;
  scope: UltraPlanBlockerScope;
  affected: UltraPlanAffectedUnitRef;
  recoverable: boolean;
  recoveryMode: UltraPlanRecoveryMode;
  nextAction: string;
  retryable: boolean;
  detectedAt: string;
  details?: Record<string, unknown>;
}

export interface UltraPlanAgentBinding {
  slot: UltraPlanAgentSlotName;
  agentType: UltraPlanAgentType;
  agentName: string;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
}

export interface UltraPlanAgentSlots {
  executor: UltraPlanAgentBinding;
  tester: UltraPlanAgentBinding;
  domainReviewEnabled: boolean;
  stackReviewEnabled: boolean;
  domainReviewer?: UltraPlanAgentBinding;
  stackReviewer?: UltraPlanAgentBinding;
}

export interface UltraPlanScenario {
  id: string;
  title: string;
  stack: UltraPlanStackId;
  domainId: string;
  level: UltraPlanScenarioLevel;
  status: UltraPlanScenarioStatus;
  steps: string[];
  assignedSlots: UltraPlanAgentSlotName[];
  proofs: UltraPlanProof[];
  dependencies?: string[];
  blocker?: UltraPlanBlocker | null;
}

export interface UltraPlanDomainReviewGate {
  enabled: boolean;
  status: UltraPlanReviewStatus;
}

export interface UltraPlanDomain {
  id: string;
  name: string;
  unit: UltraPlanScenario[];
  integration: UltraPlanScenario[];
  e2e: UltraPlanScenario[];
  review: UltraPlanDomainReviewGate;
  progress: UltraPlanProgressSummary;
}

export interface UltraPlanStack {
  stack: UltraPlanStackId;
  applicability: UltraPlanApplicability;
  domains: UltraPlanDomain[];
  status: UltraPlanSessionState;
  agentSlots: UltraPlanAgentSlots;
  progress: UltraPlanProgressSummary;
}

export interface UltraPlanCursor {
  targetType: UltraPlanCursorTargetType;
  stack: UltraPlanStackId | null;
  domainId: string | null;
  level: UltraPlanScenarioLevel | null;
  scenarioId: string | null;
  phase: UltraPlanExecutionPhase;
  status: UltraPlanCursorStatus;
  summary: string;
}

export interface UltraPlanDomainReview {
  stack: UltraPlanStackId;
  domainId: string;
  reviewerSlot: UltraPlanAgentSlotName;
  status: UltraPlanReviewStatus;
  startedAt: string;
  completedAt?: string;
  summary: string;
  artifactRef: string;
}

export interface UltraPlanStackReview {
  stack: UltraPlanStackId;
  reviewerSlot: UltraPlanAgentSlotName;
  status: UltraPlanReviewStatus;
  startedAt: string;
  completedAt?: string;
  summary: string;
  artifactRef: string;
}

export interface UltraPlanAuthoredArtifact {
  sessionId: string;
  title: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  stacks: UltraPlanStack[];
}

export interface UltraPlanManifestAuthoredRefs {
  json: string;
  markdown?: string;
}

export interface UltraPlanManifestStackSummary {
  stack: UltraPlanStackId;
  applicability: UltraPlanApplicability;
  progress: UltraPlanProgressSummary;
  domainCount: number;
  terminalDomainCount: number;
}

export interface UltraPlanManifestReviewReference {
  type: "domain" | "stack";
  stack: UltraPlanStackId;
  domainId: string | null;
  path: string;
  status: UltraPlanReviewStatus;
}

export interface UltraPlanManifest {
  sessionId: string;
  projectName: string;
  title: string;
  authored: UltraPlanManifestAuthoredRefs;
  state: UltraPlanSessionState;
  cursor: UltraPlanCursor | null;
  lastCompleted: UltraPlanCursor | null;
  progress: UltraPlanProgressSummary;
  stacks: UltraPlanManifestStackSummary[];
  blocker: UltraPlanBlocker | null;
  reviews: UltraPlanManifestReviewReference[];
  createdAt: string;
  updatedAt: string;
  /**
   * Multi-stage authoring pipeline state. Present only while a session is being authored
   * via the GSD-style pipeline (stage "approved" or transitioned to `state: "ready"` via the
   * legacy single-shot `ultraplan_create` tool leaves this field absent).
   *
   * Existing manifests written before the multi-stage pipeline shipped will not have this
   * field, and the schema treats it as optional.
   */
  authoring?: UltraPlanAuthoringState;
}

export interface UltraPlanIndexEntry {
  sessionId: string;
  title: string;
  state: UltraPlanSessionState;
  bucket: UltraPlanSessionBucket;
  createdAt: string;
  updatedAt: string;
  cursor: UltraPlanCursor | null;
  idleReason: string | null;
  /**
   * Authoring stage for sessions that are still in the multi-stage pipeline. Optional —
   * absent for sessions authored via the legacy `ultraplan_create` path or for sessions
   * already promoted to `state: "ready"`. Used by the picker to surface in-flight authoring
   * sessions ahead of executable ones.
   */
  authoringStage?: UltraPlanAuthoringStage | null;
}

export interface UltraPlanIndex {
  sessions: UltraPlanIndexEntry[];
}

export interface UltraPlanStorageError {
  kind: "missing" | "invalid-json" | "validation-error" | "io";
  path: string;
  message: string;
  details?: string[];
}

export type UltraPlanStorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: UltraPlanStorageError };

export interface UltraPlanSessionSummary {
  sessionId: string;
  projectName: string;
  title: string;
  state: UltraPlanSessionState;
  createdAt: string;
  updatedAt: string;
  cursor: UltraPlanCursor | null;
  lastCompleted: UltraPlanCursor | null;
  blocker: UltraPlanBlocker | null;
  progress: UltraPlanProgressSummary;
  stacks: UltraPlanManifestStackSummary[];
  reviews: UltraPlanManifestReviewReference[];
}

// ---------------------------------------------------------------------------
// UltraPlan multi-stage authoring pipeline (GSD-style)
//
// These types describe the state captured under `<session>/authoring/` while a
// new session is being shaped through the intake \u2192 scout \u2192 discover \u2192 research \u2192
// synthesize \u2192 review \u2192 approve pipeline. Once a session is approved, the
// manifest's top-level `state` flips to "ready" and the runtime treats the session
// as ordinary.
// ---------------------------------------------------------------------------

/**
 * Pipeline stage identifier. The order is meaningful \u2014 stages execute strictly in this
 * sequence and the reducer only ever advances one step at a time.
 *
 * `revise` is a sub-stage of review that re-spawns the planner with consolidated findings;
 * its presence is signalled by `iteration > 1`, not by a distinct stage transition.
 */
export type UltraPlanAuthoringStage =
  | "intake"
  | "scout"
  | "discover"
  | "research"
  | "synthesize"
  | "review"
  | "approve";

/** Operational status of the current stage. */
export type UltraPlanAuthoringStageStatus =
  | "pending"
  | "running"
  | "blocked"
  | "awaiting-user"
  | "done";

/** Authoring slot identifier (parallel namespace to execution slots). */
export type UltraPlanAuthoringSlotName =
  | "intake"
  | "scout"
  | "discoverer"
  | "researcher"
  | "planner"
  | "structure-checker"
  | "scope-checker"
  | "tdd-checker";

/** Pipeline mode: how aggressively the pipeline gates on user approval. */
export type UltraPlanAuthoringPipelineMode =
  | "single-shot"   // legacy quick path (ultraplan_create)
  | "multi-stage";  // default GSD-style pipeline

/** Severity of a finding raised by a plan-checker against a draft. */
export type UltraPlanAuthoringFindingSeverity = "BLOCKER" | "WARNING";

/** Which checker raised a finding. */
export type UltraPlanAuthoringFindingSource =
  | "structure-checker"
  | "scope-checker"
  | "tdd-checker";

/**
 * One item raised against a draft during REVIEW. Multiple findings consolidate into one
 * `findings.json` per iteration.
 */
export interface UltraPlanAuthoringFinding {
  id: string;
  severity: UltraPlanAuthoringFindingSeverity;
  source: UltraPlanAuthoringFindingSource;
  /** Where the finding applies; null when it is session-wide. */
  target: {
    stack: UltraPlanStackId | null;
    domainId: string | null;
    scenarioId: string | null;
  };
  /** Human-readable summary, presented to the user and to the revising planner. */
  message: string;
  /** Concrete recommendation for fixing the issue. */
  recommendation: string;
  recordedAt: string;
}

/**
 * Block of findings persisted to `drafts/iteration-N/findings.json`. The reducer reads it
 * to decide whether to converge, revise, or escalate.
 */
export interface UltraPlanAuthoringFindingsArtifact {
  iteration: number;
  draftRef: string;
  recordedAt: string;
  findings: UltraPlanAuthoringFinding[];
}

/**
 * Per-stage artifact references. Filenames are relative to `<session>/authoring/`.
 *
 * `research` is an array of stack-keyed entries because researchers fan out per applicable
 * stack. `draft` and `findings` reference iteration-numbered files; only the latest is
 * retained on this struct (older iterations live on disk for forensics).
 */
export interface UltraPlanAuthoringArtifactRefs {
  intake?: string;
  scout?: string;
  discuss?: string;
  deferredIdeas?: string;
  research?: { stack: UltraPlanStackId; path: string }[];
  researchSummary?: string;
  draft?: string;
  draftMarkdown?: string;
  findings?: string;
}

/**
 * The `authoring` block embedded inside `manifest.json` for sessions that have not yet been
 * approved. Once a session reaches APPROVE and is promoted, this block is cleared and the
 * top-level `state` becomes `"ready"`.
 */
export interface UltraPlanAuthoringState {
  pipeline: UltraPlanAuthoringPipelineMode;
  stage: UltraPlanAuthoringStage;
  stageStatus: UltraPlanAuthoringStageStatus;
  /** Iteration counter for the REVIEW \u2194 SYNTHESIZE revision loop. 1-indexed. */
  iteration: number;
  /** How many times the user has re-entered the loop after a stall warning. */
  stallReentryCount: number;
  artifacts: UltraPlanAuthoringArtifactRefs;
  blocker: UltraPlanBlocker | null;
  startedAt: string;
  updatedAt: string;
}

/**
 * Append-only event written to `<session>/authoring/pipeline-log.jsonl` whenever the pipeline
 * transitions. Mirrors `execution-log.jsonl` so the same reader can consume both streams.
 */
export interface UltraPlanAuthoringPipelineEvent {
  recordedAt: string;
  stage: UltraPlanAuthoringStage;
  stageStatus: UltraPlanAuthoringStageStatus;
  iteration: number;
  /** Human-readable summary; empty allowed when the event is purely structural. */
  summary: string;
  /** Optional structured payload (artifact path, finding count, model id, etc.). */
  details?: Record<string, unknown>;
}


// ---------------------------------------------------------------------------
// UltraPlan Slice-2 runtime contracts
// ---------------------------------------------------------------------------

export type UltraPlanHookEventName =
  | "session_start"
  | "before_agent_start"
  | "tool_call"
  | "tool_result"
  | "agent_end"
  | "session_shutdown";

export type UltraPlanActorKind = "slot" | "main-orchestrator";

export type UltraPlanSourceAgent = "main" | "sub-agent";

export type UltraPlanAttemptOutcome =
  | "advanced"
  | "blocked"
  | "interrupted"
  | "noop";

export type UltraPlanMutationKind =
  | "noop"
  | "start-attempt"
  | "stage-observation"
  | "advance"
  | "block"
  | "interrupt"
  | "repair"
  | "complete";

export type UltraPlanRuntimeBlockerCode =
  | "correlation-ambiguous"
  | "proof-missing"
  | "proof-invalid"
  | "conflicting-evidence"
  | "interrupted-attempt"
  | "persistence-failure"
  | "unsafe-repair-required"
  | "migration-unsafe"
  | "migration-conflict";

export interface UltraPlanLaunchContext {
  attemptId: string;
  attemptKey: string;
  sourceAgent: UltraPlanSourceAgent;
  launchedAt: string;
}

export interface UltraPlanObservationTarget {
  targetType: UltraPlanCursorTargetType;
  stack: UltraPlanStackId | null;
  domainId: string | null;
  level: UltraPlanScenarioLevel | null;
  scenarioId: string | null;
  phase: UltraPlanExecutionPhase;
  resolvedSlot: string | null;
}

export interface UltraPlanObservationCorrelationFailure {
  reason: string;
  details?: Record<string, unknown>;
}

export interface UltraPlanHookObservation {
  sessionId: string;
  hookEvent: UltraPlanHookEventName;
  actorKind: UltraPlanActorKind;
  attemptId: string | null;
  attemptKey: string | null;
  sourceAgent: UltraPlanSourceAgent;
  occurredAt: string;
  causationId: string | null;
  fingerprint: string;
  target: UltraPlanObservationTarget | null;
  correlationFailure: UltraPlanObservationCorrelationFailure | null;
  payloadSummary: string;
}

export interface UltraPlanProofCandidateTarget {
  targetType: UltraPlanCursorTargetType;
  stack: UltraPlanStackId | null;
  domainId: string | null;
  level: UltraPlanScenarioLevel | null;
  scenarioId: string | null;
}

export interface UltraPlanProofCandidate {
  phase: UltraPlanExecutionPhase;
  type: UltraPlanProofType;
  target: UltraPlanProofCandidateTarget;
  evidence: UltraPlanProofEvidence;
  artifactRef: string | null;
  observationFingerprint: string;
  fingerprint: string;
}

export interface UltraPlanBlockerCandidate {
  blocker: UltraPlanBlocker;
  observationFingerprint: string;
}

export interface UltraPlanAttemptRecord {
  attemptId: string;
  attemptKey: string;
  launchContext: UltraPlanLaunchContext;
  cursorSnapshot: UltraPlanCursor | null;
  observations: UltraPlanHookObservation[];
  proofCandidates: UltraPlanProofCandidate[];
  blockerCandidates: UltraPlanBlockerCandidate[];
  outcome: UltraPlanAttemptOutcome | null;
  startedAt: string;
  finalizedAt: string | null;
}

export interface UltraPlanScenarioStatusUpdate {
  stack: UltraPlanStackId;
  domainId: string;
  level: UltraPlanScenarioLevel;
  scenarioId: string;
  nextStatus: UltraPlanScenarioStatus;
  appendProof?: UltraPlanProof;
}

export interface UltraPlanReviewStatusUpdate {
  type: "domain" | "stack";
  stack: UltraPlanStackId;
  domainId: string | null;
  nextStatus: UltraPlanReviewStatus;
  artifactRef: string | null;
}

export interface UltraPlanBlockerUpdate {
  scope: UltraPlanBlockerScope;
  nextValue: UltraPlanBlocker | null;
  clearedByObservationFingerprint: string | null;
}

export type UltraPlanRepairAction =
  | { op: "recompute-cursor"; reason: string }
  | { op: "recompute-progress"; reason: string }
  | { op: "clear-active-attempt"; reason: string }
  | { op: "convert-active-to-interrupted"; attemptId: string; reason: string }
  | { op: "clear-blocker"; scope: UltraPlanBlockerScope; clearedByObservationFingerprint: string };

export interface UltraPlanTrackerAttemptFinalization {
  attemptId: string;
  outcome: UltraPlanAttemptOutcome;
  finalizedAt: string;
}

export interface UltraPlanMutationPlan {
  kind: UltraPlanMutationKind;
  rationale: string;
  appendObservationFingerprint: string | null;
  scenarioStatusUpdate: UltraPlanScenarioStatusUpdate | null;
  reviewStatusUpdate: UltraPlanReviewStatusUpdate | null;
  blockerUpdate: UltraPlanBlockerUpdate | null;
  cursorUpdate: UltraPlanCursor | null;
  sessionStateUpdate: UltraPlanSessionState | null;
  trackerAttemptFinalization: UltraPlanTrackerAttemptFinalization | null;
  recomputeProgress: boolean;
  repairActions: UltraPlanRepairAction[];
  notes: string[];
}

export interface UltraPlanPendingMutation {
  attemptId: string;
  mutationPlan: UltraPlanMutationPlan;
  expectedManifestFingerprint: string;
  stagedAt: string;
}

export interface UltraPlanRuntimeTracker {
  version: 1;
  sessionId: string;
  activeAttempt: UltraPlanAttemptRecord | null;
  finalizedAttempts: UltraPlanAttemptRecord[];
  appliedFingerprints: string[];
  pendingMutation: UltraPlanPendingMutation | null;
  updatedAt: string;
}

export interface UltraPlanRepairDetails {
  reason: string;
  actions: UltraPlanRepairAction[];
}

export type UltraPlanReducerAction =
  | { kind: "session_started"; observation: UltraPlanHookObservation; nowIso: string }
  | { kind: "attempt_started"; observation: UltraPlanHookObservation; launchContext: UltraPlanLaunchContext }
  | { kind: "observation_staged"; observation: UltraPlanHookObservation }
  | { kind: "attempt_finalized"; observation: UltraPlanHookObservation; nowIso: string }
  | { kind: "session_shutdown"; observation: UltraPlanHookObservation; nowIso: string }
  | { kind: "repair_applied"; nowIso: string; details: UltraPlanRepairDetails };

export type UltraPlanSessionMigrationKind = "copied" | "reconciled-no-op";

export interface UltraPlanSessionMigrationRecord {
  migratedAt: string;
  legacyPath: string;
  fingerprintBefore: string;
  fingerprintAfter: string;
  legacyRenamedTo: string | null;
  kind: UltraPlanSessionMigrationKind;
}

// ---------------------------------------------------------------------------
// UltraPlan Slice-7 batch orchestration contracts
// ---------------------------------------------------------------------------

export type UltraPlanBatchRunState = "paused" | "running" | "blocked" | "complete" | "abandoned";

export type UltraPlanBatchNodeState =
  | "pending"
  | "preparing"
  | "running"
  | "merge-pending"
  | "paused"
  | "blocked"
  | "awaiting-user"
  | "merged"
  | "abandoned";

export type UltraPlanBatchNodeBlockerKind = "dependency" | "session" | "merge" | "supervisor";

export type UltraPlanBatchBlockerCode =
  | "project-identity-failed"
  | "invalid-run"
  | "supervisor-worktree-invalid"
  | "base-drift"
  | "merge-blocked";

export type UltraPlanBatchJournalEventType =
  | "run-created"
  | "lease-acquired"
  | "lease-released"
  | "node-preparing"
  | "node-running"
  | "node-paused"
  | "node-blocked"
  | "node-awaiting-user"
  | "node-merge-pending"
  | "node-merged"
  | "node-abandoned"
  | "cleanup-warning";

export interface UltraPlanBatchWave {
  waveIndex: number;
  sessionIds: string[];
}

export interface UltraPlanBatchNode {
  nodeId: string;
  sessionId: string;
  title: string;
  waveIndex: number;
  dependencies: string[];
  state: UltraPlanBatchNodeState;
  blockerKind: UltraPlanBatchNodeBlockerKind | null;
  blockerSummary: string | null;
  resumeRequestedAt: string | null;
  branchName: string | null;
  worktreePath: string | null;
  updatedAt: string;
}

export interface UltraPlanBatchRun {
  runId: string;
  projectRoot: string;
  baseBranch: string;
  baseHead: string;
  currentBaseHead: string;
  createdAt: string;
  updatedAt: string;
  state: UltraPlanBatchRunState;
  maxParallelism: number;
  batchBlockerCode: UltraPlanBatchBlockerCode | null;
  batchBlockerSummary: string | null;
  batchResumeRequestedAt: string | null;
  supervisorWorktreePath: string | null;
  waves: UltraPlanBatchWave[];
  nodes: UltraPlanBatchNode[];
}

export interface UltraPlanBatchActiveRunLease {
  runId: string;
  ownerSessionId: string | null;
  leaseAcquiredAt: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
}

export interface UltraPlanBatchJournalEvent {
  runId: string;
  sessionId: string | null;
  type: UltraPlanBatchJournalEventType;
  recordedAt: string;
  summary: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Harness pipeline (Tier 1 + Tier 2 + Tier 3 anti-slop)
//
// Persisted under `~/.omp/supipowers/projects/<slug>/harness/<sessionId>/`. Output writes to
// the repo root (Tier 1 agent-neutral artifacts) and `.omp/supipowers/` (Tier 2 + Tier 3
// supipowers-aware artifacts and project-scoped queue/score files).
// ---------------------------------------------------------------------------

/** Stages of the harness pipeline. Order is meaningful. */
export type HarnessStage =
  | "discover"
  | "research"
  | "design"
  | "plan"
  | "implement"
  | "validate";

/** Operational status of a harness stage. Mirrors UltraPlanAuthoringStageStatus. */
export type HarnessStageStatus =
  | "pending"
  | "running"
  | "blocked"
  | "awaiting-user"
  | "done";

/** Pipeline gate mode (mirrors PipelineGateMode in ultraplan). */
export type HarnessGateMode = "default" | "auto" | "manual";

/** Re-run behavior decided by bare entry when an existing harness is detected. */
export type HarnessReRunMode = "harden" | "rebuild" | "cancel";

/** Anti-slop backend selection (Design stage). */
export type HarnessAntiSlopBackend =
  | "fallow"
  | "desloppify"
  | "supi-native"
  | "hybrid";

/** Slop-violation kind. Open-ended on purpose so adapters can add new sources. */
export type HarnessSlopViolationKind =
  | "duplicate"
  | "dead-code"
  | "layer-violation"
  | "naming"
  | "file-too-large"
  | "complexity"
  | "circular-dependency"
  | "other";

/** Source of a slop-queue entry. */
export type HarnessSlopSource = "fallow" | "desloppify" | "checks" | "review" | "supi-native";

/** Severity tier for queue entries. */
export type HarnessSlopSeverity = "blocker" | "warning" | "info";

/** Lifecycle state of a queue entry. */
export type HarnessSlopState = "open" | "resolved" | "wontfix";

/** A single slop-queue entry. JSONL-persisted, append-only with replacement on resolve. */
export interface HarnessSlopQueueEntry {
  id: string;
  kind: HarnessSlopViolationKind;
  file: string;
  /** Range as (start_line, end_line) or null when range is the whole file. */
  range: { startLine: number; endLine: number } | null;
  severity: HarnessSlopSeverity;
  source: HarnessSlopSource;
  state: HarnessSlopState;
  message: string;
  remediation?: string;
  /** Ids of related/clustered entries (e.g. duplicate-cluster siblings). */
  clusters?: string[];
  /** ISO8601 timestamp the entry was first observed. */
  ts: string;
  /** ISO8601 timestamp of the last state change. */
  resolvedAt?: string;
  /** Free-form metadata (e.g. fallow rule id, near-dup partner path:line). */
  details?: Record<string, unknown>;
}

/** Harness scorecard breakdown. */
export interface HarnessScoreDimension {
  name: string;
  /** Lenient: ignores wontfix items. Range 0-100. */
  lenient: number;
  /** Strict: counts wontfix items as cost. Range 0-100. */
  strict: number;
  /** Total entries that contributed to the score. */
  total: number;
  open: number;
  resolved: number;
  wontfix: number;
}

/** Aggregate harness score. */
export interface HarnessScore {
  /** ISO8601 of computation. */
  computedAt: string;
  lenient: number;
  strict: number;
  dimensions: HarnessScoreDimension[];
  /** Optional trend buckets, oldest first. */
  trend?: { ts: string; lenient: number; strict: number }[];
}

/** Layer rule parsed from docs/architecture.md. */
export interface HarnessLayerRule {
  /** Layer label, e.g. "domain", "infrastructure", "ui". */
  layer: string;
  /** Glob patterns matching files belonging to this layer. */
  globs: string[];
  /** Layers (or path globs) this layer is permitted to import. */
  allowedImports: string[];
  /** Layers (or path globs) this layer is forbidden from importing. */
  forbiddenImports: string[];
  /** Optional human-readable description. */
  description?: string;
}

/** Per-hook configuration. */
export interface HarnessHookConfig {
  pre_edit_dupe_probe: {
    enabled: boolean;
    /** Minimum similarity threshold (0-1). Default 0.85. */
    threshold: number;
    /** Minimum token count below which probe is skipped. Default 30. */
    min_token_count: number;
  };
  post_session_sweep: {
    enabled: boolean;
    /** Whether to surface a blocking steer message on new dead code. Default false. */
    block_on_new_dead_code: boolean;
  };
  layer_context_inject: {
    enabled: boolean;
    /** Maximum characters of addendum to inject. Default 800. */
    addendum_max_chars: number;
  };
  score_floor: {
    /** Strict score floor for /supi:checks blocking. Default 75. */
    strict: number;
    /** Lenient score floor. Default 90. */
    lenient: number;
    /** When true, GC exits non-zero if strict < strict floor. Default false. */
    release_blocking: boolean;
  };
}

/** The harness section of SupipowersConfig. */
export interface HarnessConfig {
  anti_slop: HarnessHookConfig;
  /** Selected backend (recorded by Design). */
  backend?: HarnessAntiSlopBackend;
  /** Threshold above which Implement defers to ultraplan batch. Default 10. */
  implement_in_session_threshold?: number;
}

/** Discover artifact (`<session>/discover.json`). */
export interface HarnessDiscoverArtifact {
  sessionId: string;
  recordedAt: string;
  /** Detected primary languages (lowercase). */
  languages: string[];
  /** Detected frameworks/libraries by category. */
  frameworks: string[];
  packageManagers: string[];
  buildTools: string[];
  testTools: string[];
  lintTools: string[];
  /** Repo shape: monorepo/single-package. */
  monorepoShape: "single-package" | "monorepo" | "polyglot" | "unknown";
  ci: { detected: boolean; provider?: string; configFiles: string[] };
  /** Existing OMP/supipowers infra detected. */
  ompInfra: {
    hasSupipowers: boolean;
    skills: string[];
    reviewAgents: string[];
    mcpServers: string[];
    plansCount: number;
  };
  /** Existing anti-slop tooling. */
  antiSlopExisting: {
    fallowConfig: string | null;
    desloppifyConfig: string | null;
    knipConfig: string | null;
    jscpdConfig: string | null;
    dependencyCruiserConfig: string | null;
    eslintConfig: string | null;
    biomeConfig: string | null;
  };
  /** Language coverage for backend recommendation. */
  languageCoverage: { language: string; fileCount: number; share: number }[];
  /** Recommended anti-slop backend. */
  recommendedBackend: HarnessAntiSlopBackend;
  recommendedBackendReason: string;
  commitConventions: { detected: boolean; style?: string };
  duplicates: { area: string; existing: string; conflict: string }[];
  notes: string[];
}

/** Research artifact (`<session>/research/<topic>.md`). Markdown body, schema for the
 * frontmatter only. */
export interface HarnessResearchFrontmatter {
  topic: string;
  /** ISO timestamp of last verification (re-run-safe). */
  lastVerified: string;
  /** Source URLs cited in the writeup; minimum 2 for the validator to pass. */
  sources: string[];
  /** Whether the writeup contains the required `## Options` and `## Recommendation` sections. */
  hasOptions: boolean;
  hasRecommendation: boolean;
}

/** Design spec artifact metadata (`<session>/design-spec.md` + decisions.jsonl). */
export interface HarnessDesignSpec {
  sessionId: string;
  recordedAt: string;
  /** Layered architecture rules user agreed to. */
  layerRules: HarnessLayerRule[];
  /** Taste invariants (text bullets). */
  tasteInvariants: string[];
  /** Tooling choices. */
  tooling: {
    lint: string | null;
    structuralTest: string | null;
    eval: string | null;
  };
  /** Top 10 mechanical golden principles. */
  goldenPrinciples: string[];
  /** Documentation tree shape (paths under docs/). */
  docsTree: string[];
  /** Validation gates the harness should install. */
  validationGates: string[];
  /** supipowers wiring opted-in by the user. */
  supipowersWiring: {
    addReviewAgent: boolean;
    wireChecksGate: boolean;
  };
  /** Anti-slop section. */
  antiSlop: {
    backend: HarnessAntiSlopBackend;
    hooks: HarnessHookConfig;
    skillTargets: string[];
  };
}

/** A single decision recorded during Design. */
export interface HarnessDecisionRecord {
  recordedAt: string;
  area: string;
  question: string;
  decision: string;
  rationale?: string;
  impact?: string[];
}

/** Validate report (`<session>/validate-report.json`). */
export interface HarnessValidateReport {
  sessionId: string;
  recordedAt: string;
  passed: boolean;
  /** Sub-check results, one per sub-check name. */
  checks: {
    name: string;
    passed: boolean;
    summary: string;
    findings: HarnessValidateFinding[];
    durationMs?: number;
  }[];
  /** Slop scan results merged from the selected backend. */
  slopScan: {
    backend: HarnessAntiSlopBackend;
    duplicates: number;
    deadCode: number;
    layerViolations: number;
    other: number;
  };
  score: HarnessScore;
  scoreFloorPassed: boolean;
  syntheticEditTest: {
    ran: boolean;
    hooksFired: string[];
    failures: string[];
  };
}

/** A single Validate finding (file:line + remediation). */
export interface HarnessValidateFinding {
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  message: string;
  remediation: string;
  source: string;
}

/** Harness session state (manifest.json under <session>/). */
export interface HarnessSession {
  sessionId: string;
  projectName: string;
  startedAt: string;
  updatedAt: string;
  stage: HarnessStage;
  stageStatus: HarnessStageStatus;
  gateMode: HarnessGateMode;
  /** Iteration counter for retry budget (per-stage). */
  iteration: number;
  /** Re-run mode user chose at bare entry (when applicable). */
  reRunMode?: HarnessReRunMode;
  /** Recorded blocker, if any. */
  blocker: { code: string; message: string; detectedAt: string } | null;
  /** Artifacts produced so far (relative to <session>/). */
  artifacts: HarnessArtifactRefs;
}

/** Per-stage artifact references (relative to <session>/). */
export interface HarnessArtifactRefs {
  discover?: string;
  research?: { topic: string; path: string }[];
  designSpec?: string;
  decisions?: string;
  plan?: string;
  implementLog?: string;
  validateReport?: string;
}

/** Append-only pipeline log entry. */
export interface HarnessPipelineEvent {
  recordedAt: string;
  stage: HarnessStage;
  stageStatus: HarnessStageStatus;
  iteration: number;
  summary: string;
  details?: Record<string, unknown>;
}