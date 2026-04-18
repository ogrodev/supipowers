import { loadModelConfig } from "../config/model-config.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { parseStructuredOutput, runWithOutputValidation } from "../ai/structured-output.js";
import { QualityGatesSchema } from "./schemas.js";
import type { Platform } from "../platform/types.js";
import type { ProjectFacts, QualityGatesConfig, SetupProposal } from "../types.js";

modelRegistry.register({
  id: "quality-gate-setup",
  category: "command",
  label: "Quality gate setup",
  harnessRoleHint: "slow",
});

const QUALITY_GATES_SCHEMA_TEXT = renderSchemaText(QualityGatesSchema);

export function buildAiSetupPrompt(projectFacts: ProjectFacts, proposal: SetupProposal): string {
  return [
    "You are configuring Supipowers review quality gates for a repository.",
    "Return JSON only as a QualityGatesConfig object matching this schema:",
    QUALITY_GATES_SCHEMA_TEXT,
    "",
    "Rules:",
    "- Prefer commands that already exist in package.json scripts.",
    "- packageScripts contains only commands shared across every discovered target; use targets to inspect package-specific scripts.",
    "- /supi:checks runs commands from each target's package root, so do not generalize a command that only works in one package.",
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
    ...(proposal.notes && proposal.notes.length > 0
      ? ["", "Deterministic baseline notes:", ...proposal.notes.map((note) => `- ${note}`)]
      : []),
  ].join("\n");
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

  const result = await runWithOutputValidation<QualityGatesConfig>(
    input.platform.createAgentSession.bind(input.platform),
    {
      cwd: input.cwd,
      prompt: buildAiSetupPrompt(input.projectFacts, input.proposal),
      schema: QUALITY_GATES_SCHEMA_TEXT,
      parse: (raw) => parseStructuredOutput<QualityGatesConfig>(raw, QualityGatesSchema),
      model: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      timeoutMs: 120_000,
      reliability: {
        paths: input.platform.paths,
        cwd: input.cwd,
        command: "quality-setup",
      },
    },
  );

  if (result.status === "blocked") {
    throw new Error(result.error);
  }

  return result.output;
}
