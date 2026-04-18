// src/docs/contracts.ts
//
// Schema-backed contract for doc-drift sub-agent output. Every doc-drift
// sub-agent must emit JSON that parses against DocDriftOutputSchema. The
// retry loop (runWithOutputValidation) will hand validation errors back to
// the model rather than letting a silent regex heuristic invent findings.

import { Type, type Static } from "@sinclair/typebox";

export const DOC_DRIFT_SEVERITIES = ["info", "warning", "error"] as const;
export const DOC_DRIFT_STATUSES = ["ok", "drifted"] as const;

export type DocDriftSeverity = (typeof DOC_DRIFT_SEVERITIES)[number];
export type DocDriftStatus = (typeof DOC_DRIFT_STATUSES)[number];

export const DocDriftFindingSchema = Type.Object(
  {
    file: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    severity: Type.Union(
      DOC_DRIFT_SEVERITIES.map((value) => Type.Literal(value)),
    ),
    relatedFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export const DocDriftOutputSchema = Type.Object(
  {
    findings: Type.Array(DocDriftFindingSchema),
    status: Type.Union(
      DOC_DRIFT_STATUSES.map((value) => Type.Literal(value)),
    ),
  },
  { additionalProperties: false },
);

export type DocDriftFinding = Static<typeof DocDriftFindingSchema>;
export type DocDriftOutput = Static<typeof DocDriftOutputSchema>;
