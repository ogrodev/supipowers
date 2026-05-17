// src/planning/spec.ts
//
// Canonical TypeBox contract for a supipowers implementation plan (PlanSpec).
// The agent produces markdown, src/storage/plans.ts parses it, and this
// schema is the validator of record. Markdown that doesn't parse into a
// PlanSpec is rejected — no silent promotion of partial artifacts.
//
// Phase 3 exit gate: PlanSpec is the canonical planning artifact; markdown
// is rendered from it via render-markdown.ts, not the other way around.

import { z } from "zod/v4";

export const TASK_COMPLEXITY_VALUES = ["small", "medium", "large"] as const;

export const PlanSpecTaskSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1),
  description: z.string(),
  files: z.array(z.string().min(1)),
  criteria: z.string(),
  complexity: z.enum(TASK_COMPLEXITY_VALUES),
  model: z.string().min(1).optional(),
}).strict();

export const PlanSpecSchema = z.object({
  name: z.string().min(1),
  /** ISO date string, e.g. "2026-04-17". Empty string is tolerated for
   * legacy plans produced before the field was required. */
  created: z.string(),
  tags: z.array(z.string()),
  context: z.string(),
  tasks: z.array(PlanSpecTaskSchema),
}).strict();

export type PlanSpec = z.infer<typeof PlanSpecSchema>;
export type PlanSpecTask = z.infer<typeof PlanSpecTaskSchema>;
