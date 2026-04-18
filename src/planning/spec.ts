// src/planning/spec.ts
//
// Canonical TypeBox contract for a supipowers implementation plan (PlanSpec).
// The agent produces markdown, src/storage/plans.ts parses it, and this
// schema is the validator of record. Markdown that doesn't parse into a
// PlanSpec is rejected — no silent promotion of partial artifacts.
//
// Phase 3 exit gate: PlanSpec is the canonical planning artifact; markdown
// is rendered from it via render-markdown.ts, not the other way around.

import { Type, type Static } from "@sinclair/typebox";

export const TASK_COMPLEXITY_VALUES = ["small", "medium", "large"] as const;

export const PlanSpecTaskSchema = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    files: Type.Array(Type.String({ minLength: 1 })),
    criteria: Type.String(),
    complexity: Type.Union(TASK_COMPLEXITY_VALUES.map((v) => Type.Literal(v))),
    model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const PlanSpecSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    /** ISO date string, e.g. "2026-04-17". Empty string is tolerated for
     * legacy plans produced before the field was required. */
    created: Type.String(),
    tags: Type.Array(Type.String()),
    context: Type.String(),
    tasks: Type.Array(PlanSpecTaskSchema),
  },
  { additionalProperties: false },
);

export type PlanSpec = Static<typeof PlanSpecSchema>;
export type PlanSpecTask = Static<typeof PlanSpecTaskSchema>;
