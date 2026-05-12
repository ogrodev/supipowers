import { describe, expect, test } from "bun:test";

import {
  attachProvenance,
  computeBodyContentHash,
} from "../../../src/harness/docs/provenance.js";
import {
  extractAgentContextSection,
  REQUIRED_HEADINGS,
  sectionLoc,
  validateLayerDocMarkdown,
} from "../../../src/harness/docs/validator.js";

const SESSION = "harness-test-deadbeef";
const SOURCE_HASH = "a".repeat(64);

function wrap(body: string): string {
  return attachProvenance(body, {
    sessionId: SESSION,
    generatedAt: "2026-05-12T12:00:00.000Z",
    contentHash: computeBodyContentHash(body),
  });
}

function defaultBody(overrides: Partial<{ layer: string; sourceHash: string; sections: string }>): string {
  const layer = overrides.layer ?? "lib";
  const sourceHash = overrides.sourceHash ?? SOURCE_HASH;
  const sections =
    overrides.sections ??
    [
      "## Agent context",
      "Tight context for the lib layer.",
      "",
      "## Purpose",
      "Independent library code.",
      "",
      "## Files",
      "- src/lib/**",
      "",
      "## Imports",
      "Permitted: (none).",
      "",
      "## Conventions",
      "No side effects.",
    ].join("\n");
  return [
    "---",
    `layer: ${layer}`,
    "generatedAt: 2026-05-12T12:00:00.000Z",
    `sourceHash: ${sourceHash}`,
    "---",
    sections,
    "",
  ].join("\n");
}

describe("validateLayerDocMarkdown", () => {
  test("accepts a well-formed doc", () => {
    const doc = wrap(defaultBody({}));
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("rejects doc over LOC cap", () => {
    // Build a body with 200 LOC of filler in the Conventions section.
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const body = defaultBody({
      sections: [
        "## Agent context",
        "ctx",
        "## Purpose",
        "p",
        "## Files",
        "f",
        "## Imports",
        "i",
        "## Conventions",
        filler,
      ].join("\n"),
    });
    const doc = wrap(body);
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
      maxDocLoc: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /max is 150/.test(e))).toBe(true);
  });

  test("rejects missing required heading", () => {
    const body = defaultBody({
      sections: [
        "## Agent context",
        "ctx",
        "## Files",
        "f",
        "## Imports",
        "i",
        "## Conventions",
        "c",
      ].join("\n"),
    });
    const doc = wrap(body);
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /missing required heading/.test(e))).toBe(true);
    expect(result.errors.some((e) => /## Purpose/.test(e))).toBe(true);
  });

  test("rejects out-of-order headings", () => {
    const body = defaultBody({
      sections: [
        "## Agent context",
        "c",
        "## Files",
        "f",
        "## Purpose",
        "p",
        "## Imports",
        "i",
        "## Conventions",
        "c",
      ].join("\n"),
    });
    const doc = wrap(body);
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /out of order/.test(e))).toBe(true);
  });

  test("rejects Agent context section exceeding cap", () => {
    const longCtx = Array.from({ length: 40 }, (_, i) => `ctx ${i}`).join("\n");
    const body = defaultBody({
      sections: [
        "## Agent context",
        longCtx,
        "## Purpose",
        "p",
        "## Files",
        "f",
        "## Imports",
        "i",
        "## Conventions",
        "c",
      ].join("\n"),
    });
    const doc = wrap(body);
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
      maxAgentContextLoc: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /Agent context section is/.test(e))).toBe(true);
  });

  test("rejects layer-id mismatch", () => {
    const doc = wrap(defaultBody({ layer: "wrong-layer" }));
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /layer mismatch/.test(e))).toBe(true);
  });

  test("rejects sourceHash mismatch", () => {
    const doc = wrap(defaultBody({ sourceHash: "deadbeef" }));
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sourceHash mismatch/.test(e))).toBe(true);
  });

  test("rejects missing frontmatter", () => {
    const body = [
      "## Agent context",
      "ctx",
      "## Purpose",
      "p",
      "## Files",
      "f",
      "## Imports",
      "i",
      "## Conventions",
      "c",
    ].join("\n");
    const doc = wrap(body);
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /missing YAML frontmatter/.test(e))).toBe(true);
  });

  test("rejects placeholder markers (TODO)", () => {
    const body = defaultBody({
      sections: [
        "## Agent context",
        "ctx",
        "## Purpose",
        "TODO finish this",
        "## Files",
        "f",
        "## Imports",
        "i",
        "## Conventions",
        "c",
      ].join("\n"),
    });
    const doc = wrap(body);
    const result = validateLayerDocMarkdown(doc, {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /TODO/.test(e))).toBe(true);
  });

  test("rejects missing provenance marker", () => {
    // No wrap()
    const result = validateLayerDocMarkdown(defaultBody({}), {
      expectedLayerId: "lib",
      expectedSourceHash: SOURCE_HASH,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /provenance marker/.test(e))).toBe(true);
  });
});

describe("sectionLoc", () => {
  test("counts only the inner body of the section", () => {
    const md = [
      "## Agent context",
      "line 1",
      "line 2",
      "",
      "## Purpose",
      "p",
    ].join("\n");
    expect(sectionLoc(md, "## Agent context")).toBe(2);
  });

  test("returns 0 when heading is absent", () => {
    expect(sectionLoc("## Purpose\np\n", "## Missing")).toBe(0);
  });
});

describe("extractAgentContextSection", () => {
  test("returns body lines of the section", () => {
    const md = [
      "## Agent context",
      "ctx 1",
      "ctx 2",
      "",
      "## Purpose",
      "p",
    ].join("\n");
    expect(extractAgentContextSection(md)).toBe("ctx 1\nctx 2");
  });

  test("respects maxLoc when provided", () => {
    const md = [
      "## Agent context",
      "a",
      "b",
      "c",
      "## Purpose",
      "p",
    ].join("\n");
    expect(extractAgentContextSection(md, 2)).toBe("a\nb");
  });
});

describe("REQUIRED_HEADINGS", () => {
  test("matches the plan's order", () => {
    expect(REQUIRED_HEADINGS).toEqual([
      "## Agent context",
      "## Purpose",
      "## Files",
      "## Imports",
      "## Conventions",
    ]);
  });
});
