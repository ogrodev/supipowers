import { loadModelConfig } from "../config/model-config.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { validateQualityGates } from "../config/schema.js";
import { stripMarkdownCodeFence } from "../text.js";
import type { Platform } from "../platform/types.js";
import type { ProjectFacts, QualityGatesConfig, SetupProposal } from "../types.js";
import { runStructuredAgentSession } from "./ai-session.js";

modelRegistry.register({
  id: "quality-gate-setup",
  category: "command",
  label: "Quality gate setup",
  harnessRoleHint: "slow",
});

function buildAiSetupPrompt(projectFacts: ProjectFacts, proposal: SetupProposal): string {
  return [
    "You are configuring Supipowers review quality gates for a repository.",
    "Return JSON only as a QualityGatesConfig object.",
    "",
    "Available gates and shapes:",
    '- "lsp-diagnostics": {"enabled": true|false}',
    '- "lint": {"enabled": true, "command": "..."} or {"enabled": false}',
    '- "typecheck": {"enabled": true, "command": "..."} or {"enabled": false}',
    '- "format": {"enabled": true, "command": "..."} or {"enabled": false}',
    '- "test-suite": {"enabled": true, "command": "..."} or {"enabled": false}',
    '- "build": {"enabled": true, "command": "..."} or {"enabled": false}',
    "",
    "Rules:",
    "- Prefer commands that already exist in package.json scripts.",
    "- Never invent a mutating format command such as --write or lint --fix.",
    "- Prefer checks that verify correctness during review: lsp, lint, typecheck, format check, tests, and build.",
    "- Keep deterministic suggestions unless you have repository evidence to improve them.",
    "- Omit gates you do not recommend instead of disabling them unless the baseline already contains them.",
    "- Do not include explanations outside the JSON.",
    "",
    "Project facts:",
    JSON.stringify(projectFacts, null, 2),
    "",
    "Deterministic baseline proposal:",
    JSON.stringify(proposal.gates, null, 2),
  ].join("\n");
}

function parseAiSetupSuggestion(raw: string): QualityGatesConfig {
  const parsed = JSON.parse(stripMarkdownCodeFence(raw)) as QualityGatesConfig;
  const validation = validateQualityGates(parsed);
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }

  return parsed;
}

export async function suggestQualityGatesWithAi(input: {
  platform: Platform;
  cwd: string;
  projectFacts: ProjectFacts;
  proposal: SetupProposal;
}): Promise<QualityGatesConfig> {
  const modelConfig = loadModelConfig(input.platform.paths, input.cwd);
  const resolvedModel = resolveModelForAction(
    "quality-gate-setup",
    modelRegistry,
    modelConfig,
    createModelBridge(input.platform),
  );

  const result = await runStructuredAgentSession(
    input.platform.createAgentSession.bind(input.platform),
    {
      cwd: input.cwd,
      prompt: buildAiSetupPrompt(input.projectFacts, input.proposal),
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      timeoutMs: 120_000,
    },
  );

  if (result.status !== "ok") {
    throw new Error(result.error);
  }

  return parseAiSetupSuggestion(result.finalText);
}
