import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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
  ReviewScope,
  ReviewScopeFile,
  ReviewScopeStats,
  ReviewSession,
  ReviewSessionArtifacts,
} from "../types.js";

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
export const REVIEW_FIX_STATUSES = ["applied", "skipped", "failed"] as const;

export const ReviewScopeFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    additions: Type.Number({ minimum: 0 }),
    deletions: Type.Number({ minimum: 0 }),
    diff: Type.String(),
  },
  { additionalProperties: false },
);

export const ReviewScopeStatsSchema = Type.Object(
  {
    filesChanged: Type.Number({ minimum: 0 }),
    excludedFiles: Type.Number({ minimum: 0 }),
    additions: Type.Number({ minimum: 0 }),
    deletions: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ReviewScopeSchema = Type.Object(
  {
    mode: Type.Union(REVIEW_SCOPE_MODES.map((mode) => Type.Literal(mode))),
    description: Type.String({ minLength: 1 }),
    diff: Type.String(),
    files: Type.Array(ReviewScopeFileSchema),
    stats: ReviewScopeStatsSchema,
    baseBranch: Type.Optional(Type.String({ minLength: 1 })),
    commit: Type.Optional(Type.String({ minLength: 1 })),
    customInstructions: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ReviewFindingValidationSchema = Type.Object(
  {
    verdict: Type.Union(REVIEW_VALIDATION_VERDICTS.map((value) => Type.Literal(value))),
    reasoning: Type.String({ minLength: 1 }),
    validatedBy: Type.String({ minLength: 1 }),
    validatedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReviewFindingSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    severity: Type.Union(REVIEW_FINDING_SEVERITIES.map((value) => Type.Literal(value))),
    priority: Type.Union(REVIEW_FINDING_PRIORITIES.map((value) => Type.Literal(value))),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    file: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    lineStart: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
    lineEnd: Type.Union([Type.Number({ minimum: 1 }), Type.Null()]),
    body: Type.String({ minLength: 1 }),
    suggestion: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    agent: Type.Optional(Type.String({ minLength: 1 })),
    validation: Type.Optional(ReviewFindingValidationSchema),
  },
  { additionalProperties: false },
);

export const ReviewOutputSchema = Type.Object(
  {
    findings: Type.Array(ReviewFindingSchema),
    summary: Type.String({ minLength: 1 }),
    status: Type.Union(REVIEW_OUTPUT_STATUSES.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
);

export const ReviewAgentConfigSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    enabled: Type.Boolean(),
    data: Type.String({ minLength: 1 }),
    model: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const ReviewAgentsConfigSchema = Type.Object(
  {
    agents: Type.Array(ReviewAgentConfigSchema),
  },
  { additionalProperties: false },
);

export const ReviewAgentFrontmatterSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    focus: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ReviewIterationSummarySchema = Type.Object(
  {
    iteration: Type.Number({ minimum: 1 }),
    findings: Type.Number({ minimum: 0 }),
    status: Type.Union(REVIEW_OUTPUT_STATUSES.map((value) => Type.Literal(value))),
    file: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ReviewFixRecordSchema = Type.Object(
  {
    findingIds: Type.Array(Type.String({ minLength: 1 })),
    file: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: Type.Union(REVIEW_FIX_STATUSES.map((value) => Type.Literal(value))),
    summary: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const REVIEW_FIX_OUTPUT_STATUSES = ["applied", "partial", "skipped", "blocked"] as const;

export const ReviewFixOutputSchema = Type.Object(
  {
    fixes: Type.Array(ReviewFixRecordSchema),
    summary: Type.String({ minLength: 1 }),
    status: Type.Union(REVIEW_FIX_OUTPUT_STATUSES.map((value) => Type.Literal(value))),
  },
  { additionalProperties: false },
);


export const ReviewSessionArtifactsSchema = Type.Object(
  {
    scope: Type.String({ minLength: 1 }),
    iterationsDir: Type.String({ minLength: 1 }),
    agentsDir: Type.String({ minLength: 1 }),
    rawFindings: Type.Optional(Type.String({ minLength: 1 })),
    validatedFindings: Type.Optional(Type.String({ minLength: 1 })),
    consolidatedFindings: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ReviewSessionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    level: Type.Union(REVIEW_LEVELS.map((value) => Type.Literal(value))),
    status: Type.Union(REVIEW_SESSION_STATUSES.map((value) => Type.Literal(value))),
    scope: ReviewScopeSchema,
    validateFindings: Type.Boolean(),
    consolidate: Type.Boolean(),
    autoFix: Type.Boolean(),
    maxIterations: Type.Number({ minimum: 0 }),
    currentIteration: Type.Number({ minimum: 0 }),
    iterations: Type.Array(ReviewIterationSummarySchema),
    fixes: Type.Array(ReviewFixRecordSchema),
    artifacts: ReviewSessionArtifactsSchema,
    agents: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export interface ReviewValidationError {
  path: string;
  message: string;
}

function normalizeErrorPath(path: string): string {
  return path.replace(/^\//, "").replace(/\//g, ".") || "(root)";
}

export function collectReviewValidationErrors(schema: TSchema, data: unknown): ReviewValidationError[] {
  return [...Value.Errors(schema, data)].map((error) => ({
    path: normalizeErrorPath(error.path),
    message: error.message,
  }));
}

export function formatReviewValidationErrors(errors: ReviewValidationError[]): string[] {
  return errors.map((error) => `${error.path}: ${error.message}`);
}

export function isReviewScopeFile(value: unknown): value is ReviewScopeFile {
  return Value.Check(ReviewScopeFileSchema, value);
}

export function isReviewScopeStats(value: unknown): value is ReviewScopeStats {
  return Value.Check(ReviewScopeStatsSchema, value);
}

export function isReviewScope(value: unknown): value is ReviewScope {
  return Value.Check(ReviewScopeSchema, value);
}

export function isReviewFinding(value: unknown): value is ReviewFinding {
  return Value.Check(ReviewFindingSchema, value);
}

export function isReviewOutput(value: unknown): value is ReviewOutput {
  return Value.Check(ReviewOutputSchema, value);
}

export function isReviewAgentConfig(value: unknown): value is ReviewAgentConfig {
  return Value.Check(ReviewAgentConfigSchema, value);
}

export function isReviewAgentsConfig(value: unknown): value is ReviewAgentsConfig {
  return Value.Check(ReviewAgentsConfigSchema, value);
}

export function isReviewSessionArtifacts(value: unknown): value is ReviewSessionArtifacts {
  return Value.Check(ReviewSessionArtifactsSchema, value);
}

export function isReviewIterationSummary(value: unknown): value is ReviewIterationSummary {
  return Value.Check(ReviewIterationSummarySchema, value);
}

export function isReviewFixRecord(value: unknown): value is ReviewFixRecord {
  return Value.Check(ReviewFixRecordSchema, value);
}

export function isReviewSession(value: unknown): value is ReviewSession {
  return Value.Check(ReviewSessionSchema, value);
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
