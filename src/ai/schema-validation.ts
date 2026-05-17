// src/ai/schema-validation.ts
//
// Thin façade over Zod's `safeParse` that produces a flat `ValidationError[]`
// shape compatible with the rest of supipowers (`parseStructuredOutput`,
// `getUltraPlanSchemaErrors`, every gate prompt that formats validation
// failures for retry).
//
// All contracts in supipowers are authored as Zod schemas (`zod/v4`). The
// helpers here intentionally accept the structural interface — anything with
// a working `safeParse` — so they keep working under the OMP TypeBox-shim
// (extension load time) without needing a separate code path.

import type { ZodType } from "zod/v4";
import type { ValidationError } from "../types.js";

interface ZodIssueLike {
  path: ReadonlyArray<string | number | symbol>;
  message: string;
  code?: string;
  expected?: unknown;
  received?: unknown;
  /** Present on Zod 4 `unrecognized_keys` issues. */
  keys?: ReadonlyArray<string>;
}

function pathToString(path: ReadonlyArray<string | number | symbol>): string {
  // Zod 4 path segments are `(string | number | symbol)[]`; symbols only
  // appear for schemas with symbol keys (not used in supipowers). Drop them
  // so the printed path stays readable.
  const stringy = path.filter((segment): segment is string | number => typeof segment !== "symbol");
  return stringy.length === 0 ? "(root)" : stringy.map(String).join(".");
}

function expandIssue(issue: ZodIssueLike): ValidationError[] {
  // Zod 4 reports unrecognized strict-object keys with the offending keys in
  // `issue.keys` and the path stopped at the parent object. Expand each key
  // into its own ValidationError with the key appended to the path so
  // formatted error strings (`<path>: <message>`) still identify the exact
  // field the model produced wrongly. This matches the prompt-driven
  // self-correction loop in `parseStructuredOutput`, which needs to tell
  // the model which key to drop.
  if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && issue.keys.length > 0) {
    return issue.keys.map((key) => ({
      path: pathToString([...issue.path, key]),
      message: issue.message,
      ...(issue.code ? { code: issue.code } : {}),
      ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
      ...(issue.received !== undefined ? { received: issue.received } : {}),
    }));
  }

  return [{
    path: pathToString(issue.path),
    message: issue.message,
    ...(issue.code ? { code: issue.code } : {}),
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.received !== undefined ? { received: issue.received } : {}),
  }];
}

/**
 * Validate `data` against `schema`. Returns an empty array on success and
 * a stable `{path, message, ...}` shape on failure. Callers format the
 * result for prompts/CLI/UI without further normalisation.
 */
export function collectSchemaValidationErrors(schema: ZodType, data: unknown): ValidationError[] {
  const result = schema.safeParse(data);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) => expandIssue(issue as ZodIssueLike));
}

/** Convenience wrapper. Equivalent to `collectSchemaValidationErrors(...).length === 0`. */
export function checkSchema(schema: ZodType, data: unknown): boolean {
  return schema.safeParse(data).success;
}

/**
 * Parse `data` against `schema`. On success returns the schema-validated
 * (and Zod-transformed) value; on failure returns the flattened error list.
 */
export function parseSchema<T>(schema: ZodType<T>, data: unknown): { success: true; data: T } | { success: false; errors: ValidationError[] } {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    errors: result.error.issues.flatMap((issue) => expandIssue(issue as ZodIssueLike)),
  };
}
