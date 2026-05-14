import { describe, expect, test } from "bun:test";
import type { WriteCommandAction, WriteRuleAction } from "../../src/context/startup-optimizer.js";
import {
  MANAGED_RULE_HEADER,
  MANAGED_COMMAND_HEADER,
  MANAGED_EXTENSION_HEADER,
  parseManagedRule,
  parseManagedCommand,
  parseManagedExtension,
  renderManagedRule,
  renderManagedCommand,
  renderManagedExtension,
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

function commandAction(overrides: Partial<WriteCommandAction> = {}): WriteCommandAction {
  return {
    kind: "write-command",
    sourceId: "skill:workflow-extractor",
    sourceName: "workflow-extractor",
    sourceHash: "c".repeat(64),
    slug: "skill-workflow-extractor",
    commandName: "workflow-extractor",
    targetPath: ".omp/commands/workflow-extractor.md",
    sourceBytes: 321,
    estimatedSavedBytes: 321,
    sourceContent: "## workflow-extractor\nRun this workflow.",
    description: "Run workflow extraction on demand.",
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

  test("renders TTSR frontmatter with readable trigger metadata and text scope", () => {
    const condition = String.raw`\b(?:debug|root\s+cause|quote\"safe)\b`;
    const rendered = renderManagedRule(action({
      mode: "ttsr",
      condition,
      triggers: "debug, root cause",
      scope: "text",
    }));

    expect(rendered.startsWith(MANAGED_RULE_HEADER)).toBe(true);
    expect(rendered).toContain("mode: ttsr");
    expect(rendered).toContain(`condition: ${JSON.stringify(condition)}`);
    expect(rendered).toContain(`triggers: ${JSON.stringify("debug, root cause")}`);
    expect(rendered).toContain(`scope: ${JSON.stringify("text")}`);

    const parsed = parseManagedRule(rendered);
    expect(parsed.status).toBe("managed");
    if (parsed.status !== "managed") throw new Error("expected managed rule");
    expect(parsed.frontmatter.condition).toBe(condition);
    expect(parsed.frontmatter.triggers).toBe("debug, root cause");
    expect(parsed.frontmatter.scope).toBe("text");
    expect(parsed.frontmatter.description).toBeUndefined();
  });
});

describe("renderManagedCommand", () => {
  test("renders project slash command frontmatter and preserves source", () => {
    const rendered = renderManagedCommand(commandAction());

    expect(rendered.startsWith("---\n")).toBe(true);
    expect(rendered.startsWith(MANAGED_COMMAND_HEADER)).toBe(false);
    expect(rendered).toContain("supipowers-managed-command: \"1\"");
    expect(rendered).toContain("commandName: \"workflow-extractor\"");
    expect(rendered).toContain("description: \"Run workflow extraction on demand.\"");
    expect(rendered).toContain("## workflow-extractor");
    const parsed = parseManagedCommand(rendered);
    expect(parsed.status).toBe("managed");
    if (parsed.status !== "managed") throw new Error("expected managed command");
    expect(parsed.metadata.commandName).toBe("workflow-extractor");
    expect(parsed.frontmatter.description).toBe("Run workflow extraction on demand.");
    expect(parsed.body).toBe("## workflow-extractor\nRun this workflow.");
    expect(parsed.body).not.toContain("supipowers-managed-command");
    expect(parsed.body).not.toContain("sourceHash:");
  });
});

describe("parseManagedExtension", () => {
  test("parses managed extension metadata and body", () => {
    const rendered = renderManagedExtension({
      kind: "write-extension",
      sourceId: "extension:runbook",
      sourceName: "supipowers-runbook",
      sourceHash: "d".repeat(64),
      slug: "extension-runbook",
      extensionName: "supipowers-runbook",
      targetPath: ".omp/extensions/supipowers-runbook.ts",
      sourceBytes: 17,
      estimatedSavedBytes: 0,
      sourceContent: "export default function() {}\n",
    });
    expect(rendered.startsWith(MANAGED_EXTENSION_HEADER)).toBe(true);
    const parsed = parseManagedExtension(rendered);
    expect(parsed.status).toBe("managed");
    if (parsed.status !== "managed") throw new Error("expected managed extension");
    expect(parsed.metadata.extensionName).toBe("supipowers-runbook");
    expect(parsed.body).toBe("export default function() {}");
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
