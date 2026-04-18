// src/review/output.ts
//
// Review-specific thin wrappers over the shared structured-output foundation.
// Everything generic (parseStructuredOutput<T>, runWithOutputValidation<T>,
// StructuredOutputResult<T>, validation-error helpers) lives in
// src/ai/structured-output.ts. This module exists only so review callers can
// parse a raw model response into ReviewOutput without rewriting the schema
// reference at every site.

import { parseStructuredOutput } from "../ai/structured-output.js";
import type { ReviewOutput } from "../types.js";
import { ReviewOutputSchema } from "./types.js";

export function parseReviewOutput(raw: string): ReviewOutput | null {
  return parseStructuredOutput<ReviewOutput>(raw, ReviewOutputSchema).output;
}

export function explainReviewOutputFailure(raw: string): string | null {
  return parseStructuredOutput<ReviewOutput>(raw, ReviewOutputSchema).error;
}
