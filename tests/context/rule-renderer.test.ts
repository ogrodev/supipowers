import { describe, expect, test } from "bun:test";
import type { WriteRuleAction } from "../../src/context/startup-optimizer.js";
import {
  MANAGED_RULE_HEADER,
  parseManagedRule,
  renderManagedRule,
} from "../../src/context/rule-renderer.js";

function action(overrides: Partial<WriteRuleAction> = {}): WriteRuleAction {
  return {
    kind: "write-rule",
    mode: "rulebook",
    sourceId: "skill:database-reference",
    sourceName: "database-reference",
    sourceHash: "a".repeat(64),
    slug: "skill-database-reference",
    targetPath: ".omp/rules/skill-database-reference.md",
    sourceBytes: 1234,
    estimatedSavedBytes: 1234,
    sourceContent: [
      "## database-reference",
      "",
      "<!-- ignore this managed-source comment -->",
      "Reference details with \"quotes\": use only on demand.",
      "Original body must be preserved.",
    ].join("\n"),
    ...overrides,
  };
}

describe("renderManagedRule", () => {
  test("renders rulebook frontmatter with YAML-safe description and preserves source", () => {
    const rendered = renderManagedRule(action({
      description: "Use \"quoted\" values\nonly when needed",
    }));

    expect(rendered.startsWith(MANAGED_RULE_HEADER)).toBe(true);
    expect(rendered).toContain("mode: rulebook");
    expect(rendered).toContain("description: \"Use \\\"quoted\\\" values\\nonly when needed\"");
    expect(rendered).not.toContain("description: \"Use \"quoted\" values\nonly when needed\"");
    expect(rendered).toContain("## database-reference");
    expect(rendered).toContain("Original body must be preserved.");

    const parsed = parseManagedRule(rendered);
    expect(parsed.status).toBe("managed");
    if (parsed.status !== "managed") throw new Error("expected managed rule");
    expect(parsed.metadata).toMatchObject({
      mode: "rulebook",
      sourceId: "skill:database-reference",
      sourceHash: "a".repeat(64),
      slug: "skill-database-reference",
    });
    expect(parsed.frontmatter.description).toBe("Use \"quoted\" values\nonly when needed");
    expect(parsed.body).toContain("Original body must be preserved.");
  });

  test("derives rulebook description from first content line when absent", () => {
    const rendered = renderManagedRule(action({ description: undefined }));
    expect(rendered).toContain("description: \"Reference details with \\\"quotes\\\": use only on demand.\"");
  });

  test("renders TTSR frontmatter with YAML-safe condition", () => {
    const condition = String.raw`\b(?:debug|root\s+cause|quote\"safe)\b`;
    const rendered = renderManagedRule(action({
      mode: "ttsr",
      condition,
    }));

    expect(rendered.startsWith(MANAGED_RULE_HEADER)).toBe(true);
    expect(rendered).toContain("mode: ttsr");
    expect(rendered).toContain(`condition: ${JSON.stringify(condition)}`);

    const parsed = parseManagedRule(rendered);
    expect(parsed.status).toBe("managed");
    if (parsed.status !== "managed") throw new Error("expected managed rule");
    expect(parsed.frontmatter.condition).toBe(condition);
    expect(parsed.frontmatter.description).toBeUndefined();
  });
});

describe("parseManagedRule", () => {
  test("distinguishes unmanaged files from managed files", () => {
    expect(parseManagedRule("---\ndescription: user rule\n---\nbody")).toEqual({
      status: "unmanaged",
      managed: false,
    });
  });

  test("reports malformed managed frontmatter", () => {
    const malformed = `${MANAGED_RULE_HEADER}\nversion: 1\nmode: rulebook\nsourceId: skill:x\nsourceName: x\nsourceHash: ${"b".repeat(64)}\nslug: skill-x\nsourceBytes: 12\n-->\n---\ndescription: \"unterminated\n---\nbody`;
    const parsed = parseManagedRule(malformed);
    expect(parsed.status).toBe("malformed");
    if (parsed.status !== "malformed") throw new Error("expected malformed rule");
    expect(parsed.managed).toBe(true);
    expect(parsed.error).toContain("frontmatter");
  });
});
