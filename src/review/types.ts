import { z } from "zod/v4";
import type { ZodType } from "zod/v4";
import type {
  ConfiguredReviewAgent,
  ReviewAgentConfig,
  ReviewAgentDefinition,
  ReviewAgentsConfig,
  ReviewFinding,
  ReviewFixOutput,
  ReviewFixRecord,
  ReviewIterationSummary,
  ReviewOutput,
  ReviewPostConsolidationAction,
  ReviewScope,
  ReviewScopeFile,
  ReviewScopeStats,
  ReviewSession,
  ReviewSessionArtifacts,
  ThinkingLevel,
} from "../types.js";
import { checkSchema } from "../ai/schema-validation.js";
export type {
  ConfiguredReviewAgent,
  ReviewAgentConfig,
  ReviewAgentDefinition,
  ReviewAgentsConfig,
  ReviewFinding,
  ReviewFixOutput,
  ReviewFixRecord,
  ReviewIterationSummary,
  ReviewOutput,
  ReviewPostConsolidationAction,
  ReviewScope,
  ReviewScopeFile,
  ReviewScopeStats,
  ReviewSession,
  ReviewSessionArtifacts,
} from "../types.js";
export const REVIEW_LEVELS = ["quick", "deep", "multi-agent"] as const;
export const REVIEW_SCOPE_MODES = ["pull-request", "uncommitted", "commit", "custom"] as const;
export const REVIEW_OUTPUT_STATUSES = ["passed", "failed", "blocked"] as const;
export const REVIEW_FINDING_SEVERITIES = ["error", "warning", "info"] as const;
export const REVIEW_FINDING_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const REVIEW_VALIDATION_VERDICTS = ["confirmed", "rejected", "uncertain"] as const;
export const REVIEW_SESSION_STATUSES = ["running", "completed", "blocked", "cancelled"] as const;
export const REVIEW_POST_CONSOLIDATION_ACTIONS = ["fix-now", "document-only", "discuss-before-fixing"] as const;
export const REVIEW_FIX_STATUSES = ["applied", "skipped", "failed"] as const;

export const ReviewScopeFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().min(0),
  deletions: z.number().min(0),
  diff: z.string(),
}).strict();

export const ReviewScopeStatsSchema = z.object({
  filesChanged: z.number().min(0),
  excludedFiles: z.number().min(0),
  additions: z.number().min(0),
  deletions: z.number().min(0),
}).strict();

export const ReviewScopeSchema = z.object({
  mode: z.enum(REVIEW_SCOPE_MODES),
  description: z.string().min(1),
  diff: z.string(),
  files: z.array(ReviewScopeFileSchema),
  stats: ReviewScopeStatsSchema,
  baseBranch: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  customInstructions: z.string().min(1).optional(),
}).strict();

export const ReviewFindingValidationSchema = z.object({
  verdict: z.enum(REVIEW_VALIDATION_VERDICTS),
  reasoning: z.string().min(1),
  validatedBy: z.string().min(1),
  validatedAt: z.string().min(1),
}).strict();

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  priority: z.enum(REVIEW_FINDING_PRIORITIES),
  confidence: z.number().min(0).max(1),
  file: z.string().min(1).nullable(),
  lineStart: z.number().min(1).nullable(),
  lineEnd: z.number().min(1).nullable(),
  body: z.string().min(1),
  suggestion: z.string().min(1).nullable(),
  agent: z.string().min(1).optional(),
  validation: ReviewFindingValidationSchema.optional(),
}).strict();

export const ReviewOutputSchema = z.object({
  findings: z.array(ReviewFindingSchema),
  summary: z.string().min(1),
  status: z.enum(REVIEW_OUTPUT_STATUSES),
}).strict();

export const ReviewAgentConfigSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  data: z.string().min(1),
  model: z.string().min(1).nullable(),
  thinkingLevel: z.union([
    z.literal("off"),
    z.literal("minimal"),
    z.literal("low"),
    z.literal("medium"),
    z.literal("high"),
    z.literal("xhigh"),
    z.null(),
  ]).optional(),
  peerCoordination: z.boolean().optional(),
}).strict();

export const ReviewAgentsConfigSchema = z.object({
  agents: z.array(ReviewAgentConfigSchema),
}).strict();

export const ReviewAgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  focus: z.string().min(1).optional(),
}).strict();

export const ReviewIterationSummarySchema = z.object({
  iteration: z.number().min(1),
  findings: z.number().min(0),
  status: z.enum(REVIEW_OUTPUT_STATUSES),
  file: z.string().min(1),
  createdAt: z.string().min(1),
}).strict();

export const ReviewFixRecordSchema = z.object({
  findingIds: z.array(z.string().min(1)),
  file: z.string().min(1).nullable(),
  status: z.enum(REVIEW_FIX_STATUSES),
  summary: z.string().min(1),
}).strict();

export const REVIEW_FIX_OUTPUT_STATUSES = ["applied", "partial", "skipped", "blocked"] as const;

export const ReviewFixOutputSchema = z.object({
  fixes: z.array(ReviewFixRecordSchema),
  summary: z.string().min(1),
  status: z.enum(REVIEW_FIX_OUTPUT_STATUSES),
}).strict();


export const ReviewSessionArtifactsSchema = z.object({
  scope: z.string().min(1),
  iterationsDir: z.string().min(1),
  agentsDir: z.string().min(1),
  rawFindings: z.string().min(1).optional(),
  validatedFindings: z.string().min(1).optional(),
  consolidatedFindings: z.string().min(1).optional(),
  findingsReport: z.string().min(1).optional(),
}).strict();

export const ReviewSessionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  level: z.enum(REVIEW_LEVELS),
  status: z.enum(REVIEW_SESSION_STATUSES),
  scope: ReviewScopeSchema,
  validateFindings: z.boolean(),
  consolidate: z.boolean(),
  postConsolidationAction: z.enum(REVIEW_POST_CONSOLIDATION_ACTIONS).nullable(),
  maxIterations: z.number().min(0),
  currentIteration: z.number().min(0),
  iterations: z.array(ReviewIterationSummarySchema),
  fixes: z.array(ReviewFixRecordSchema),
  artifacts: ReviewSessionArtifactsSchema,
  agents: z.array(z.string().min(1)),
}).strict();


export function isReviewScopeFile(value: unknown): value is ReviewScopeFile {
  return checkSchema(ReviewScopeFileSchema, value);
}

export function isReviewScopeStats(value: unknown): value is ReviewScopeStats {
  return checkSchema(ReviewScopeStatsSchema, value);
}

export function isReviewScope(value: unknown): value is ReviewScope {
  return checkSchema(ReviewScopeSchema, value);
}

export function isReviewFinding(value: unknown): value is ReviewFinding {
  return checkSchema(ReviewFindingSchema, value);
}

export function isReviewOutput(value: unknown): value is ReviewOutput {
  return checkSchema(ReviewOutputSchema, value);
}

export function isReviewAgentConfig(value: unknown): value is ReviewAgentConfig {
  return checkSchema(ReviewAgentConfigSchema, value);
}

export function isReviewAgentsConfig(value: unknown): value is ReviewAgentsConfig {
  return checkSchema(ReviewAgentsConfigSchema, value);
}

export function isReviewSessionArtifacts(value: unknown): value is ReviewSessionArtifacts {
  return checkSchema(ReviewSessionArtifactsSchema, value);
}

export function isReviewIterationSummary(value: unknown): value is ReviewIterationSummary {
  return checkSchema(ReviewIterationSummarySchema, value);
}

export function isReviewFixRecord(value: unknown): value is ReviewFixRecord {
  return checkSchema(ReviewFixRecordSchema, value);
}

export function isReviewSession(value: unknown): value is ReviewSession {
  return checkSchema(ReviewSessionSchema, value);
}

export function isReviewAgentDefinition(value: unknown): value is ReviewAgentDefinition {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as ReviewAgentDefinition;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.description === "string" &&
    candidate.description.length > 0 &&
    (candidate.focus === null || typeof candidate.focus === "string") &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.length > 0 &&
    typeof candidate.filePath === "string" &&
    candidate.filePath.length > 0
  );
}
