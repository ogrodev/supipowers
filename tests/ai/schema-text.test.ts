import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { renderSchemaText } from "../../src/ai/schema-text.js";

describe("renderSchemaText — primitives", () => {
  test("string / integer / number / boolean / null", () => {
    expect(renderSchemaText(z.string() as never)).toBe("string");
    expect(renderSchemaText(z.number().int() as never)).toBe("integer");
    expect(renderSchemaText(z.number() as never)).toBe("number");
    expect(renderSchemaText(z.boolean() as never)).toBe("boolean");
    expect(renderSchemaText(z.null() as never)).toBe("null");
  });
});

describe("renderSchemaText — unions and literals", () => {
  test("renders string literal as JSON-quoted string", () => {
    expect(renderSchemaText(z.literal("ok") as never)).toBe('"ok"');
  });

  test("renders union of string literals as pipe-separated", () => {
    const Sev = z.union([z.literal("error"), z.literal("warning"), z.literal("info")]);
    expect(renderSchemaText(Sev as never)).toBe('"error" | "warning" | "info"');
  });

  test("renders nullable field as union with null", () => {
    expect(renderSchemaText(z.string().nullable() as never)).toBe("string | null");
  });
});

describe("renderSchemaText — objects", () => {
  test("renders required and optional fields with TS separator", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int().optional(),
    });
    const rendered = renderSchemaText(schema as never);
    expect(rendered).toContain("name: string;");
    expect(rendered).toContain("age?: integer;");
  });

  test("empty object renders as {}", () => {
    expect(renderSchemaText(z.object({}) as never)).toBe("{}");
  });

  test("nested objects indent children", () => {
    const schema = z.object({
      outer: z.object({
        inner: z.string(),
      }),
    });
    const rendered = renderSchemaText(schema as never);
    expect(rendered).toContain("outer: {");
    expect(rendered).toContain("inner: string;");
  });
});

describe("renderSchemaText — arrays", () => {
  test("renders array of primitive with T[] suffix", () => {
    expect(renderSchemaText(z.array(z.string()) as never)).toBe("string[]");
  });

  test("wraps array of object in Array<...> for readability", () => {
    const schema = z.array(z.object({ id: z.string() }));
    expect(renderSchemaText(schema as never)).toStartWith("Array<{");
  });
});

describe("renderSchemaText — review contract drift detection", () => {
  test("non-empty and contains every top-level review field", async () => {
    const { ReviewOutputSchema } = await import("../../src/review/types.js");
    const rendered = renderSchemaText(ReviewOutputSchema);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("findings:");
    expect(rendered).toContain("summary: string;");
    expect(rendered).toContain("status:");
    expect(rendered).toContain('"passed"');
    expect(rendered).toContain('"failed"');
    expect(rendered).toContain('"blocked"');
  });

  test("non-empty and contains every top-level fix-output field", async () => {
    const { ReviewFixOutputSchema } = await import("../../src/review/types.js");
    const rendered = renderSchemaText(ReviewFixOutputSchema);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toContain("fixes:");
    expect(rendered).toContain("summary: string;");
    expect(rendered).toContain("status:");
  });
});

// OMP injects a Zod-backed shim for `@sinclair/typebox` when extensions are
// loaded, so any schema imported via `Type.X(...)` at extension runtime is a
// Zod schema, not a JSON-Schema-shaped object. The renderer must walk both
// shapes — module-level callers like `const SCHEMA_TEXT = renderSchemaText(Schema)`
// will throw during extension load otherwise (see omp.2026-05-16.log:
// "undefined is not an object (evaluating 'any.enum')").
describe("renderSchemaText — Zod schemas (OMP runtime shim)", () => {
  test("renders primitives", () => {
    expect(renderSchemaText(z.string() as never)).toBe("string");
    expect(renderSchemaText(z.number() as never)).toBe("number");
    expect(renderSchemaText(z.boolean() as never)).toBe("boolean");
    expect(renderSchemaText(z.null() as never)).toBe("null");
  });

  test("renders union of literals as pipe-separated", () => {
    const sev = z.union([z.literal("error"), z.literal("warning"), z.literal("info")]);
    expect(renderSchemaText(sev as never)).toBe('"error" | "warning" | "info"');
  });

  test("renders object with required and optional fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().optional(),
    });
    const rendered = renderSchemaText(schema as never);
    expect(rendered).toContain("name: string;");
    expect(rendered).toContain("age?: number;");
  });

  test("renders array of object via Array<...> wrapper", () => {
    const schema = z.array(z.object({ id: z.string() }));
    expect(renderSchemaText(schema as never)).toStartWith("Array<{");
  });
});
