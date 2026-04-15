import agentReviewWrapperPrompt from "./prompts/agent-review-wrapper.md" with { type: "text" };
import outputInstructionsPrompt from "./prompts/output-instructions.md" with { type: "text" };
import reviewOutputSchema from "./prompts/review-output-schema.md" with { type: "text" };
import type { ConfiguredReviewAgent, GateExecutionContext, ReviewOutput, ReviewScope } from "../types.js";
import { explainReviewOutputFailure, parseReviewOutput, runWithOutputValidation } from "./output.js";
import { renderReviewTemplate } from "./template.js";

export interface MultiAgentReviewInput {
  cwd: string;
  scope: ReviewScope;
  agents: ConfiguredReviewAgent[];
  createAgentSession: GateExecutionContext["createAgentSession"];
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  onAgentStart?: (agent: ConfiguredReviewAgent) => void;
  onAgentComplete?: (result: MultiAgentAgentResult) => void;
}

export interface MultiAgentAgentResult {
  agent: ConfiguredReviewAgent;
  output: ReviewOutput;
  attempts: number;
  rawOutputs: string[];
}

export interface MultiAgentReviewResult {
  agents: MultiAgentAgentResult[];
  output: ReviewOutput;
}

function renderOutputInstructions(): string {
  return renderReviewTemplate(outputInstructionsPrompt, {
    outputSchema: reviewOutputSchema.trim(),
  });
}

export function buildConfiguredAgentPrompt(agent: ConfiguredReviewAgent, scope: ReviewScope): string {
  if (!agent.prompt.includes("{output_instructions}")) {
    throw new Error(`Review agent ${agent.name} is missing the {output_instructions} placeholder.`);
  }

  const outputInstructions = renderOutputInstructions();
  const agentPrompt = renderReviewTemplate(
    agent.prompt.replaceAll("{output_instructions}", "{{outputInstructions}}"),
    { outputInstructions },
  );

  return renderReviewTemplate(agentReviewWrapperPrompt, {
    agent,
    agentPrompt,
    scope,
  });
}

function aggregateAgentOutputs(results: MultiAgentAgentResult[]): ReviewOutput {
  const findings = results.flatMap((result) =>
    result.output.findings.map((finding) => ({
      ...finding,
      agent: finding.agent ?? result.agent.name,
    })),
  );
  const blockedAgents = results.filter((result) => result.output.status === "blocked").length;
  const summary = `Ran ${results.length} review agents: ${findings.length} findings, ${blockedAgents} blocked.`;

  return {
    findings,
    summary,
    status: blockedAgents > 0 ? "blocked" : findings.length > 0 ? "failed" : "passed",
  };
}

async function runConfiguredAgent(
  input: Omit<MultiAgentReviewInput, "agents">,
  agent: ConfiguredReviewAgent,
): Promise<MultiAgentAgentResult> {
  input.onAgentStart?.(agent);

  const result = await runWithOutputValidation(input.createAgentSession, {
    cwd: input.cwd,
    prompt: buildConfiguredAgentPrompt(agent, input.scope),
    schema: reviewOutputSchema.trim(),
    parse(raw) {
      const output = parseReviewOutput(raw);
      return {
        output,
        error: output ? null : explainReviewOutputFailure(raw),
      };
    },
    model: agent.model ?? input.model,
    thinkingLevel: agent.thinkingLevel ?? input.thinkingLevel ?? null,
    timeoutMs: input.timeoutMs ?? 120_000,
  });

  if (result.status === "blocked") {
    const blockedResult = {
      agent,
      output: {
        findings: [],
        summary: result.error,
        status: "blocked",
      },
      attempts: result.attempts,
      rawOutputs: result.rawOutputs,
    } satisfies MultiAgentAgentResult;
    input.onAgentComplete?.(blockedResult);
    return blockedResult;
  }

  const completedResult = {
    agent,
    output: {
      ...result.output,
      findings: result.output.findings.map((finding) => ({
        ...finding,
        agent: finding.agent ?? agent.name,
      })),
    },
    attempts: result.attempts,
    rawOutputs: [result.rawOutput],
  } satisfies MultiAgentAgentResult;
  input.onAgentComplete?.(completedResult);
  return completedResult;
}

export async function runMultiAgentReview(input: MultiAgentReviewInput): Promise<MultiAgentReviewResult> {
  const results = await Promise.all(
    input.agents.map((agent) => runConfiguredAgent(input, agent)),
  );

  return {
    agents: results,
    output: aggregateAgentOutputs(results),
  };
}
