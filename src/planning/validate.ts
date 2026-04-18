// src/planning/validate.ts
//
// Typed validation helpers for PlanSpec. Consumers (plan command, approval
// flow) call `validatePlanSpec(data)` and branch on `.output` vs `.error`.
// Everyone converges on the same path so validation errors surface in one
// consistent shape with field-level paths.

import { Value } from "@sinclair/typebox/value";
import { collectValidationErrors, formatValidationErrors } from "../ai/structured-output.js";
import type { ValidationError } from "../types.js";
import { PlanSpecSchema, type PlanSpec } from "./spec.js";

export interface PlanSpecValidationResult {
  output: PlanSpec | null;
  error: string | null;
  errors: ValidationError[];
}

/**
 * Validate an arbitrary value against PlanSpecSchema. Returns `{output, null}`
 * on success and `{null, error, errors}` on failure, where `error` is a
 * human-readable summary and `errors` lists every field-level issue.
 */
export function validatePlanSpec(data: unknown): PlanSpecValidationResult {
  if (Value.Check(PlanSpecSchema, data)) {
    return { output: data as PlanSpec, error: null, errors: [] };
  }

  const errors = collectValidationErrors(PlanSpecSchema, data);
  const error = errors.length > 0
    ? formatValidationErrors(errors).join("; ")
    : "Plan does not match the PlanSpec schema.";
  return { output: null, error, errors };
}

/**
 * Narrowing predicate for PlanSpec. Use when you do not need error detail.
 */
export function isPlanSpec(value: unknown): value is PlanSpec {
  return Value.Check(PlanSpecSchema, value);
}


// ---------------------------------------------------------------------------
// Markdown-level convenience
// ---------------------------------------------------------------------------

import { parsePlan } from "../storage/plans.js";
import { renderPlanSpec } from "./render-markdown.js";

export interface PlanMarkdownValidationResult extends PlanSpecValidationResult {
  /** Canonical markdown rendered from the validated PlanSpec. Null on failure. */
  canonicalMarkdown: string | null;
}

/**
 * Parse a plan markdown document, project it into a PlanSpec candidate,
 * validate against PlanSpecSchema, and render the canonical markdown for a
 * validated spec. On failure, returns `canonicalMarkdown: null` alongside
 * the usual error and errors fields.
 */
export function validatePlanMarkdown(content: string, planFileName: string = ""): PlanMarkdownValidationResult {
  const parsed = parsePlan(content, planFileName);
  const candidate = {
    name: parsed.name,
    created: parsed.created,
    tags: parsed.tags,
    context: parsed.context,
    tasks: parsed.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      files: t.files,
      criteria: t.criteria,
      complexity: t.complexity,
      ...(t.model ? { model: t.model } : {}),
    })),
  };
  const validated = validatePlanSpec(candidate);
  return {
    ...validated,
    canonicalMarkdown: validated.output ? renderPlanSpec(validated.output) : null,
  };
}