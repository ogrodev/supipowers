// src/ai/schema-text.ts
//
// Render a Zod schema as compact TS-like text suitable for embedding in
// prompts. One canonical rendering means that adding a field to a Zod
// contract automatically updates every prompt that references it through
// this module — no hand-maintained schema prose to drift.
//
// Consumers:
//   - src/review/* (runner, multi-agent-runner, validator, fixer) render
//     ReviewOutputSchema / ReviewFixOutputSchema for both the main prompt
//     and the retry prompt produced by runWithOutputValidation.
//
// Implementation note:
//   We don't walk Zod's internal `_zod.def` tree directly. Zod's JSON Schema
//   accessor (`z.toJSONSchema`) already emits draft-2020-12 output for every
//   shape we use; we walk that intermediate JSON Schema instead, which keeps
//   this module independent of Zod's internal AST changes.
//
// Non-goals:
//   - Produce standards-compliant JSON Schema output. Call `z.toJSONSchema`
//     directly for that. This renderer optimises for model readability.
//   - Capture every modifier. Supported shapes cover the current contract
//     surface; extend when a real consumer needs more.

import { z, type ZodType } from "zod/v4";

const INDENT = "  ";

type JsonSchemaNode = Record<string, unknown>;

export interface RenderSchemaOptions {
  /** Start indent (internal recursion use). */
  depth?: number;
}

function indent(depth: number): string {
  return INDENT.repeat(depth);
}

function renderLiteral(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function renderUnion(parts: readonly JsonSchemaNode[], depth: number): string {
  if (parts.length === 0) return "never";
  return parts.map((p) => renderJsonSchema(p, depth)).join(" | ");
}

function renderObject(schema: JsonSchemaNode, depth: number): string {
  const props = schema.properties as Record<string, JsonSchemaNode> | undefined;
  if (!props || Object.keys(props).length === 0) {
    return "{}";
  }

  const required: string[] = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const lines: string[] = ["{"];
  const childDepth = depth + 1;

  for (const [key, child] of Object.entries(props)) {
    const isRequired = required.includes(key);
    const separator = isRequired ? ":" : "?:";
    lines.push(`${indent(childDepth)}${key}${separator} ${renderJsonSchema(child, childDepth)};`);
  }

  lines.push(`${indent(depth)}}`);
  return lines.join("\n");
}

function renderArray(schema: JsonSchemaNode, depth: number): string {
  const items = schema.items as JsonSchemaNode | undefined;
  if (!items) return "unknown[]";
  const inner = renderJsonSchema(items, depth);
  // Wrap multiline object types as Array<...> for readability.
  if (inner.includes("\n")) {
    return `Array<${inner}>`;
  }
  return `${inner}[]`;
}

function isZodSchema(value: unknown): value is ZodType {
  return value !== null && typeof value === "object" && "_zod" in (value as Record<string, unknown>);
}

function renderJsonSchema(schema: JsonSchemaNode, depth: number): string {
  // Literal / const
  if ("const" in schema) {
    return renderLiteral(schema.const);
  }

  // Explicit enum
  if (Array.isArray(schema.enum)) {
    return schema.enum.map(renderLiteral).join(" | ");
  }

  // Union (anyOf / oneOf)
  if (Array.isArray(schema.anyOf)) {
    return renderUnion(schema.anyOf as JsonSchemaNode[], depth);
  }
  if (Array.isArray(schema.oneOf)) {
    return renderUnion(schema.oneOf as JsonSchemaNode[], depth);
  }

  // Primitive / structural by `type`
  const type = typeof schema.type === "string" ? schema.type : undefined;
  switch (type) {
    case "object":
      return renderObject(schema, depth);
    case "array":
      return renderArray(schema, depth);
    case "string":
      return "string";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      break;
  }

  // Nothing matched — render as `unknown` rather than throwing so prompts
  // still get something readable if someone adds an exotic shape.
  return "unknown";
}

/**
 * Render a Zod schema as a compact TS-like type string. Safe to pass as
 * the `schema:` param to `runWithOutputValidation` and the `{{outputSchema}}`
 * placeholder inside review prompts.
 *
 * The OMP runtime injects a Zod-backed shim for any extension that still
 * imports `@sinclair/typebox`, so even legacy callers reach this function
 * with a Zod schema. Non-Zod inputs (legitimate JSON Schema literals) are
 * walked as-is.
 */
export function renderSchemaText(schema: ZodType | JsonSchemaNode, options: RenderSchemaOptions = {}): string {
  const depth = options.depth ?? 0;
  const jsonSchema = isZodSchema(schema)
    ? (z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonSchemaNode)
    : schema;
  return renderJsonSchema(jsonSchema, depth);
}
