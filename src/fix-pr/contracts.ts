// src/fix-pr/contracts.ts
//
// Schema-backed contract for the per-comment assessment artifact produced
// before any code edits begin. Every fix-pr run must emit JSON that parses
// against FixPrAssessmentBatchSchema; downstream work batches are derived
// from this validated artifact, not from ad-hoc orchestration prose.

import { z } from "zod/v4"

export const FIX_PR_ASSESSMENT_VERDICTS = ["apply", "reject", "investigate"] as const;
export type FixPrAssessmentVerdict = (typeof FIX_PR_ASSESSMENT_VERDICTS)[number];

export const FixPrCommentAssessmentSchema = z.object({
  commentId: z.number().int(),
  verdict: z.enum(FIX_PR_ASSESSMENT_VERDICTS),
  rationale: z.string().min(1),
  affectedFiles: z.array(z.string().min(1)),
  rippleEffects: z.array(z.string().min(1)),
  verificationPlan: z.string().min(1),
}).strict();

export const FixPrAssessmentBatchSchema = z.object({
  assessments: z.array(FixPrCommentAssessmentSchema),
  summary: z.string().optional(),
}).strict();

export type FixPrCommentAssessment = z.infer<typeof FixPrCommentAssessmentSchema>;
export type FixPrAssessmentBatch = z.infer<typeof FixPrAssessmentBatchSchema>;

/**
 * A deterministic execution unit derived from a validated FixPrAssessmentBatch.
 * Only `apply` verdicts produce work batches; reject/investigate are tracked in
 * the assessment artifact but excluded from execution.
 */
export interface FixPrWorkBatch {
  id: string;
  commentIds: number[];
  affectedFiles: string[];
}
