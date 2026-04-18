// src/quality/contracts.ts
//
// TypeBox contracts for AI-driven quality-gate workflows. Embedded into
// prompts via ai/schema-text.ts and used by ai/structured-output.ts to
// validate model output with retry-on-invalid feedback.

import { Type, type Static } from "@sinclair/typebox";

const ISSUE_SEVERITIES = ["error", "warning", "info"] as const;
const RECOMMENDED_STATUSES = ["passed", "failed", "blocked"] as const;

export const AiReviewIssueSchema = Type.Object(
  {
    severity: Type.Union(ISSUE_SEVERITIES.map((value) => Type.Literal(value))),
    message: Type.String({ minLength: 1 }),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AiReviewOutputSchema = Type.Object(
  {
    summary: Type.String(),
    issues: Type.Array(AiReviewIssueSchema),
    recommendedStatus: Type.Union(
      RECOMMENDED_STATUSES.map((value) => Type.Literal(value)),
    ),
  },
  { additionalProperties: false },
);

export type AiReviewOutput = Static<typeof AiReviewOutputSchema>;
