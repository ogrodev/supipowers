// src/docs/contracts.ts
//
// Schema-backed contract for doc-drift sub-agent output. Every doc-drift
// sub-agent must emit JSON that parses against DocDriftOutputSchema. The
// retry loop (runWithOutputValidation) will hand validation errors back to
// the model rather than letting a silent regex heuristic invent findings.

import { z } from "zod/v4"

export const DOC_DRIFT_SEVERITIES = ["info", "warning", "error"] as const;
export const DOC_DRIFT_STATUSES = ["ok", "drifted"] as const;

export type DocDriftSeverity = (typeof DOC_DRIFT_SEVERITIES)[number];
export type DocDriftStatus = (typeof DOC_DRIFT_STATUSES)[number];

export const DocDriftFindingSchema = z.object({
  file: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(DOC_DRIFT_SEVERITIES),
  relatedFiles: z.array(z.string().min(1)).optional(),
}).strict();

export const DocDriftOutputSchema = z.object({
  findings: z.array(DocDriftFindingSchema),
  status: z.enum(DOC_DRIFT_STATUSES),
}).strict();

export type DocDriftFinding = z.infer<typeof DocDriftFindingSchema>;
export type DocDriftOutput = z.infer<typeof DocDriftOutputSchema>;
