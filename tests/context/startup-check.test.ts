import { describe, expect, test } from "bun:test";
import type { ParsedSkill, PromptSection } from "../../src/context/analyzer.js";
import type { StartupOptimizerManifest } from "../../src/context/startup-check.js";
import { runStartupCheck } from "../../src/context/startup-check.js";
import { MANAGED_COMMAND_HEADER, MANAGED_RULE_END, renderManagedCommand, renderManagedRule } from "../../src/context/rule-renderer.js";
import {
  hashOptimizationSource,
  type ManualOptimizationAction,
  type WriteCommandAction,
  type WriteRuleAction,
} from "../../src/context/startup-optimizer.js";
import { mergeManagedTokenignore } from "../../src/context/tokenignore.js";

const RULE_PATH = ".omp/rules/skill-debugging.md";
const TOKENIGNORE_PATH = ".omp/supipowers/.tokenignore";
const MANIFEST_PATH = ".omp/supipowers/context-optimizer/manifest.json";
const TOKENIGNORE_ENTRIES = [".omp/supipowers/debug/", "dist/"];

const SOURCE_CONTENT = "## debugging\nDebugging guidance";
const SOURCE_BYTES = new TextEncoder().encode(SOURCE_CONTENT).length;
const SOURCE_HASH = hashOptimizationSource(SOURCE_CONTENT);

const COMMAND_SOURCE_CONTENT = "## workflow-extractor\nWorkflow guidance";
const COMMAND_SOURCE_BYTES = new TextEncoder().encode(COMMAND_SOURCE_CONTENT).length;
const COMMAND_SOURCE_HASH = hashOptimizationSource(COMMAND_SOURCE_CONTENT);

function skill(name: string, content?: string): ParsedSkill {
  const text = content ?? `## ${name}\ncontent`;
  return {
    name,
    content: text,
    bytes: new TextEncoder().encode(text).length,
    tokens: Math.ceil(text.length / 4),
  };
}

function section(label: string, content: string): PromptSection {
  return {
    label,
    content,
    bytes: new TextEncoder().encode(content).length,
  };
}

function rule(overrides: Partial<WriteRuleAction> = {}): WriteRuleAction {
  return {
    kind: "write-rule",
    mode: "ttsr",
    sourceId: "skill:debugging",
    sourceName: "debugging",
    sourceHash: SOURCE_HASH,
    slug: "skill-debugging",
    targetPath: RULE_PATH,
    sourceBytes: SOURCE_BYTES,
    estimatedSavedBytes: SOURCE_BYTES,
    sourceContent: SOURCE_CONTENT,
    condition: String.raw`\bdebug\b`,
    ...overrides,
  };
}

function command(overrides: Partial<WriteCommandAction> = {}): WriteCommandAction {
  return {
    kind: "write-command",
    sourceId: "skill:workflow-extractor",
    sourceName: "workflow-extractor",
    sourceHash: COMMAND_SOURCE_HASH,
    slug: "skill-workflow-extractor",
    commandName: "workflow-extractor",
    targetPath: ".omp/commands/workflow-extractor.md",
    sourceBytes: COMMAND_SOURCE_BYTES,
    estimatedSavedBytes: COMMAND_SOURCE_BYTES,
    sourceContent: COMMAND_SOURCE_CONTENT,
    description: "Run workflow-extractor on demand.",
    ...overrides,
  };
}

function legacyManagedCommand(action: WriteCommandAction): string {
  const description = action.description ?? `Run ${action.sourceName} on demand.`;
  const body = action.sourceContent.endsWith("\n")
    ? action.sourceContent
    : `${action.sourceContent}\n`;
  return [
    MANAGED_COMMAND_HEADER,
    "version: 1",
    `sourceId: ${action.sourceId}`,
    `sourceName: ${action.sourceName}`,
    `sourceHash: ${action.sourceHash}`,
    `slug: ${action.slug}`,
    `commandName: ${action.commandName}`,
    `sourceBytes: ${action.sourceBytes}`,
    MANAGED_RULE_END,
    "---",
    `description: ${JSON.stringify(description)}`,
    "---",
    body,
  ].join("\n");
}

function manifest(overrides: Partial<StartupOptimizerManifest> = {}): StartupOptimizerManifest {
  const tokenignore = mergeManagedTokenignore(null, TOKENIGNORE_ENTRIES);
  return {
    version: 1,
    targetBytes: 32_000,
    sourceSetHash: "b".repeat(64),
    beforeBytes: 48_000,
    estimatedAfterBytes: 24_000,
    estimatedSavedBytes: 24_000,
    rules: [
      {
        path: RULE_PATH,
        mode: "ttsr",
        sourceId: "skill:debugging",
        sourceName: "debugging",
        sourceHash: SOURCE_HASH,
        slug: "skill-debugging",
        sourceBytes: SOURCE_BYTES,
        condition: String.raw`\bdebug\b`,
      },
    ],
    commands: [],
    extensions: [],
    tokenignore: {
      path: TOKENIGNORE_PATH,
      entries: TOKENIGNORE_ENTRIES,
      hash: tokenignore.hash,
    },
    manualActions: [
      {
        kind: "manual-disable",
        reason: "source-still-loaded",
        sourceId: "skill:debugging",
        sourceName: "debugging",
        sourceHash: SOURCE_HASH,
        slug: "skill-debugging",
        remediation: "Disable debugging",
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof runStartupCheck>[0]> = {}): Parameters<typeof runStartupCheck>[0] {
  const tokenignore = mergeManagedTokenignore(null, TOKENIGNORE_ENTRIES);
  return {
    manifestPath: MANIFEST_PATH,
    manifestText: JSON.stringify(manifest(), null, 2),
    ruleFiles: { [RULE_PATH]: renderManagedRule(rule()) },
    commandFiles: {},
    extensionFiles: {},
    tokenignorePath: TOKENIGNORE_PATH,
    tokenignoreText: tokenignore.content,
    currentPrompt: "small prompt",
    currentSkills: [],
    currentSections: [],
    ...overrides,
  };
}

function reasons(report: ReturnType<typeof runStartupCheck>): string[] {
  return report.issues.map((entry) => entry.reason).sort();
}

describe("runStartupCheck", () => {
  test("passes when manifest, generated rules, tokenignore, prompt budget, and loaded skills agree", () => {
    const report = runStartupCheck(input());
    expect(report.status).toBe("pass");
    expect(report.issues).toEqual([]);
    expect(report.currentBytes).toBeGreaterThan(0);
    expect(report.targetBytes).toBe(32_000);
  });

  test("fails when manifest is missing", () => {
    const report = runStartupCheck(input({ manifestText: null }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("missing-manifest");
  });

  test("fails when manifest is malformed", () => {
    const report = runStartupCheck(input({ manifestText: "{not json" }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("malformed-manifest");
  });

  test("fails when a generated rule file is missing", () => {
    const report = runStartupCheck(input({ ruleFiles: {} }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("missing-rule");
  });

  test("fails when a generated rule file is unmanaged", () => {
    const report = runStartupCheck(input({ ruleFiles: { [RULE_PATH]: "---\ndescription: user\n---\nbody" } }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("unmanaged-rule");
  });

  test("fails when a managed rule source hash drifts", () => {
    const report = runStartupCheck(input({
      ruleFiles: { [RULE_PATH]: renderManagedRule(rule({ sourceHash: "c".repeat(64) })) },
    }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("rule-drift");
  });

  test("fails when a managed rule body has been mutated", () => {
    const original = renderManagedRule(rule());
    const mutated = original.replace("Debugging guidance", "EVIL guidance injected later");
    const report = runStartupCheck(input({ ruleFiles: { [RULE_PATH]: mutated } }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("rule-body-drift");
  });

  test("passes when a managed TTSR rule uses a persisted non-text scope", () => {
    const scopedRule = rule({ scope: "tool" });
    const built = manifest({
      rules: [{
        path: scopedRule.targetPath,
        mode: scopedRule.mode,
        sourceId: scopedRule.sourceId,
        sourceName: scopedRule.sourceName,
        sourceHash: scopedRule.sourceHash,
        slug: scopedRule.slug,
        sourceBytes: scopedRule.sourceBytes,
        condition: scopedRule.condition,
        scope: scopedRule.scope,
      }],
    });
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      ruleFiles: { [scopedRule.targetPath]: renderManagedRule(scopedRule) },
    }));

    expect(report.status).toBe("pass");
    expect(report.issues).toEqual([]);
  });

  test("fails when a managed rule has malformed frontmatter", () => {
    const malformedRule = renderManagedRule(rule()).replace("condition: ", "condition: \"unterminated");
    const report = runStartupCheck(input({ ruleFiles: { [RULE_PATH]: malformedRule } }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("malformed-rule");
  });

  test("fails when a generated command file is missing", () => {
    const cmd = command();
    const built = manifest({
      commands: [{
        path: cmd.targetPath,
        sourceId: cmd.sourceId,
        sourceName: cmd.sourceName,
        sourceHash: cmd.sourceHash,
        slug: cmd.slug,
        commandName: cmd.commandName,
        sourceBytes: cmd.sourceBytes,
        description: cmd.description,
      }],
    });
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      commandFiles: {},
    }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("missing-command");
  });

  test("passes when generated command file matches manifest", () => {
    const cmd = command();
    const built = manifest({
      commands: [{
        path: cmd.targetPath,
        sourceId: cmd.sourceId,
        sourceName: cmd.sourceName,
        sourceHash: cmd.sourceHash,
        slug: cmd.slug,
        commandName: cmd.commandName,
        sourceBytes: cmd.sourceBytes,
        description: cmd.description,
      }],
    });
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      commandFiles: { [cmd.targetPath]: renderManagedCommand(cmd) },
    }));
    expect(report.status).toBe("pass");
    expect(report.issues).toEqual([]);
  });

  test("fails when generated command still uses legacy prompt-leaking metadata", () => {
    const cmd = command();
    const built = manifest({
      commands: [{
        path: cmd.targetPath,
        sourceId: cmd.sourceId,
        sourceName: cmd.sourceName,
        sourceHash: cmd.sourceHash,
        slug: cmd.slug,
        commandName: cmd.commandName,
        sourceBytes: cmd.sourceBytes,
        description: cmd.description,
      }],
    });
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      commandFiles: { [cmd.targetPath]: legacyManagedCommand(cmd) },
    }));

    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("command-drift");
  });

  test("fails when tokenignore managed block drifts", () => {
    const drifted = mergeManagedTokenignore(null, ["other/"]).content;
    const report = runStartupCheck(input({ tokenignoreText: drifted }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("tokenignore-drift");
  });

  test("fails when a migrated source skill is still loaded", () => {
    const report = runStartupCheck(input({ currentSkills: [skill("debugging")] }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("still-loaded-source");
  });

  test("fails when a tech-stack manual-disable source is still loaded even without a generated rule", () => {
    const techDisable: ManualOptimizationAction = {
      kind: "manual-disable",
      reason: "tech-stack-irrelevant",
      sourceId: "skill:shadcn-ui",
      sourceName: "shadcn-ui",
      sourceHash: "d".repeat(64),
      slug: "skill-shadcn-ui",
      remediation: "Disable shadcn-ui; not relevant.",
    };
    const built = manifest({ manualActions: [...manifest().manualActions, techDisable] });
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      currentSkills: [skill("shadcn-ui")],
    }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("still-loaded-source");
  });

  test("fails when manual-agents-split section is still over threshold", () => {
    const splitAction: ManualOptimizationAction = {
      kind: "manual-agents-split",
      sourceId: "section:AGENTS.md",
      sourceName: "AGENTS.md",
      sourceHash: "e".repeat(64),
      sourceBytes: 50_000,
      thresholdBytes: 8_000,
      remediation: "Split AGENTS.md.",
    };
    const built = manifest({ manualActions: [...manifest().manualActions, splitAction] });
    const stillBig = "x".repeat(20_000);
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      currentSections: [section("AGENTS.md", stillBig)],
    }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("unresolved-manual-action");
  });

  test("passes when manual-agents-split section has been reduced below threshold", () => {
    const splitAction: ManualOptimizationAction = {
      kind: "manual-agents-split",
      sourceId: "section:AGENTS.md",
      sourceName: "AGENTS.md",
      sourceHash: "e".repeat(64),
      sourceBytes: 50_000,
      thresholdBytes: 8_000,
      remediation: "Split AGENTS.md.",
    };
    const built = manifest({ manualActions: [...manifest().manualActions, splitAction] });
    const small = "x".repeat(100);
    const report = runStartupCheck(input({
      manifestText: JSON.stringify(built, null, 2),
      currentSections: [section("AGENTS.md", small)],
    }));
    expect(reasons(report)).not.toContain("unresolved-manual-action");
  });

  test("fails when current prompt remains over target", () => {
    const report = runStartupCheck(input({ currentPrompt: "x".repeat(32_001) }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toContain("prompt-over-target");
  });

  test("fails truthfully when current prompt evidence is unavailable", () => {
    const report = runStartupCheck(input({ currentPrompt: null }));
    expect(report.status).toBe("fail");
    expect(reasons(report)).toEqual(["prompt-unavailable"]);
  });
});
