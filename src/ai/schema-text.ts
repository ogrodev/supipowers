// src/ai/schema-text.ts
//
// Render a TypeBox schema as compact TS-like text suitable for embedding in
// prompts. One canonical rendering means that adding a field to a TypeBox
// contract automatically updates every prompt that references it through
// this module — no hand-maintained schema prose to drift.
//
// Consumers:
//   - src/review/* (runner, multi-agent-runner, validator, fixer) render
//     ReviewOutputSchema / ReviewFixOutputSchema for both the main prompt
//     and the retry prompt produced by runWithOutputValidation.
//
// Non-goals:
//   - Produce standards-compliant JSON Schema output. Use TypeBox's own
//     JSON Schema accessors for that. This renderer optimises for model
//     readability, not spec compliance.
//   - Capture every TypeBox modifier. Supported shapes cover the current
//     contract surface; extend when a real consumer needs more.

import type { TSchema } from "@sinclair/typebox";

const INDENT = "  ";

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

function renderUnion(parts: readonly TSchema[], depth: number): string {
  if (parts.length === 0) return "never";
  return parts.map((p) => renderSchemaText(p, { depth })).join(" | ");
}

function renderObject(schema: any, depth: number): string {
  const props = schema.properties as Record<string, TSchema> | undefined;
  if (!props || Object.keys(props).length === 0) {
    return "{}";
  }

  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const lines: string[] = ["{"];
  const childDepth = depth + 1;

  for (const [key, child] of Object.entries(props)) {
    const isRequired = required.includes(key);
    const separator = isRequired ? ":" : "?:";
    lines.push(`${indent(childDepth)}${key}${separator} ${renderSchemaText(child, { depth: childDepth })};`);
  }

  lines.push(`${indent(depth)}}`);
  return lines.join("\n");
}

function renderArray(schema: any, depth: number): string {
  const inner = renderSchemaText(schema.items as TSchema, { depth });
  // Wrap multiline object types as Array<...> for readability.
  if (inner.includes("\n")) {
    return `Array<${inner}>`;
  }
  return `${inner}[]`;
}

function hasKey(schema: any, key: string): boolean {
  return schema != null && typeof schema === "object" && key in schema;
}

/**
 * Render a TypeBox schema as a compact TS-like type string. Safe to pass as
 * the `schema:` param to `runWithOutputValidation` and the `{{outputSchema}}`
 * placeholder inside review prompts.
 */
export function renderSchemaText(schema: TSchema, options: RenderSchemaOptions = {}): string {
  const depth = options.depth ?? 0;
  const any = schema as any;

  // Literal / const
  if (hasKey(any, "const")) {
    return renderLiteral(any.const);
  }

  // Explicit enum
  if (Array.isArray(any.enum)) {
    return any.enum.map(renderLiteral).join(" | ");
  }

  // Union (anyOf / oneOf)
  if (Array.isArray(any.anyOf)) {
    return renderUnion(any.anyOf, depth);
  }
  if (Array.isArray(any.oneOf)) {
    return renderUnion(any.oneOf, depth);
  }

  // Primitive / structural by `type`
  const type = any.type as string | undefined;
  switch (type) {
    case "object":
      return renderObject(any, depth);
    case "array":
      return renderArray(any, depth);
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
      // Fall through — unknown shape
      break;
  }

  // Nothing matched — render as `unknown` rather than throwing so prompts
  // still get something readable if someone adds an exotic schema.
  return "unknown";
}
