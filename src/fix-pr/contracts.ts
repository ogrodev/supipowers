// src/fix-pr/contracts.ts
//
// Schema-backed contract for the per-comment assessment artifact produced
// before any code edits begin. Every fix-pr run must emit JSON that parses
// against FixPrAssessmentBatchSchema; downstream work batches are derived
// from this validated artifact, not from ad-hoc orchestration prose.

import { Type, type Static } from "@sinclair/typebox";

export const FIX_PR_ASSESSMENT_VERDICTS = ["apply", "reject", "investigate"] as const;
export type FixPrAssessmentVerdict = (typeof FIX_PR_ASSESSMENT_VERDICTS)[number];

export const FixPrCommentAssessmentSchema = Type.Object(
  {
    commentId: Type.Integer(),
    verdict: Type.Union(
      FIX_PR_ASSESSMENT_VERDICTS.map((value) => Type.Literal(value)),
    ),
    rationale: Type.String({ minLength: 1 }),
    affectedFiles: Type.Array(Type.String({ minLength: 1 })),
    rippleEffects: Type.Array(Type.String({ minLength: 1 })),
    verificationPlan: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const FixPrAssessmentBatchSchema = Type.Object(
  {
    assessments: Type.Array(FixPrCommentAssessmentSchema),
    summary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type FixPrCommentAssessment = Static<typeof FixPrCommentAssessmentSchema>;
export type FixPrAssessmentBatch = Static<typeof FixPrAssessmentBatchSchema>;

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
