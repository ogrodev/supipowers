// src/quality/contracts.ts
//
// Zod contracts for AI-driven quality-gate workflows. Embedded into
// prompts via ai/schema-text.ts and used by ai/structured-output.ts to
// validate model output with retry-on-invalid feedback.

import { z } from "zod/v4";

const ISSUE_SEVERITIES = ["error", "warning", "info"] as const;
const RECOMMENDED_STATUSES = ["passed", "failed", "blocked"] as const;

export const AiReviewIssueSchema = z.object({
  severity: z.enum(ISSUE_SEVERITIES),
  message: z.string().min(1),
  file: z.string().optional(),
  line: z.number().optional(),
  detail: z.string().optional(),
}).strict();

export const AiReviewOutputSchema = z.object({
  summary: z.string(),
  issues: z.array(AiReviewIssueSchema),
  recommendedStatus: z.enum(RECOMMENDED_STATUSES),
}).strict();

export type AiReviewOutput = z.infer<typeof AiReviewOutputSchema>;
