import type { ZodType } from "zod/v4";
import { checkSchema as checkRuntimeSchema, parseSchema } from "../../src/ai/schema-validation.js";

export function checkSchema(schema: ZodType, data: unknown): boolean {
  return checkRuntimeSchema(schema, data);
}

export function parseOrThrow<T>(schema: ZodType<T>, data: unknown): T {
  const result = parseSchema<T>(schema, data);
  if (result.success) return result.data;
  throw new Error(result.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
}
