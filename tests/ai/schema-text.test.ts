import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { renderSchemaText } from "../../src/ai/schema-text.js";

describe("renderSchemaText — primitives", () => {
  test("string / integer / number / boolean / null", () => {
    expect(renderSchemaText(Type.String())).toBe("string");
    expect(renderSchemaText(Type.Integer())).toBe("integer");
    expect(renderSchemaText(Type.Number())).toBe("number");
    expect(renderSchemaText(Type.Boolean())).toBe("boolean");
    expect(renderSchemaText(Type.Null())).toBe("null");
  });
});

describe("renderSchemaText — unions and literals", () => {
  test("renders string literal as JSON-quoted string", () => {
    expect(renderSchemaText(Type.Literal("ok"))).toBe('"ok"');
  });

  test("renders union of string literals as pipe-separated", () => {
    const Sev = Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]);
    expect(renderSchemaText(Sev)).toBe('"error" | "warning" | "info"');
  });

  test("renders nullable field as union with null", () => {
    expect(renderSchemaText(Type.Union([Type.String(), Type.Null()]))).toBe("string | null");
  });
});

describe("renderSchemaText — objects", () => {
  test("renders required and optional fields with TS separator", () => {
    const schema = Type.Object({
      name: Type.String(),
      age: Type.Optional(Type.Integer()),
    });
    const rendered = renderSchemaText(schema);
    expect(rendered).toContain("name: string;");
    expect(rendered).toContain("age?: integer;");
  });

  test("empty object renders as {}", () => {
    expect(renderSchemaText(Type.Object({}))).toBe("{}");
  });

  test("nested objects indent children", () => {
    const schema = Type.Object({
      outer: Type.Object({
        inner: Type.String(),
      }),
    });
    const rendered = renderSchemaText(schema);
    expect(rendered).toContain("outer: {");
    expect(rendered).toContain("inner: string;");
  });
});

describe("renderSchemaText — arrays", () => {
  test("renders array of primitive with T[] suffix", () => {
    expect(renderSchemaText(Type.Array(Type.String()))).toBe("string[]");
  });

  test("wraps array of object in Array<...> for readability", () => {
    const schema = Type.Array(Type.Object({ id: Type.String() }));
    expect(renderSchemaText(schema)).toStartWith("Array<{");
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
