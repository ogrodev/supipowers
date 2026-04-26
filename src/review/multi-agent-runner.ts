import agentReviewWrapperPrompt from "./prompts/agent-review-wrapper.md" with { type: "text" };
import outputInstructionsPrompt from "./prompts/output-instructions.md" with { type: "text" };
import type { ConfiguredReviewAgent, GateExecutionContext, ReviewOutput, ReviewScope } from "../types.js";
import { runWithOutputValidation, type ReliabilityReporter } from "../ai/structured-output.js";
import { renderSchemaText } from "../ai/schema-text.js";
import { explainReviewOutputFailure, parseReviewOutput } from "./output.js";
import { renderTemplate } from "../ai/template.js";
import { ReviewOutputSchema } from "./types.js";

const REVIEW_OUTPUT_SCHEMA_TEXT = renderSchemaText(ReviewOutputSchema);

export interface MultiAgentReviewInput {
  cwd: string;
  scope: ReviewScope;
  agents: ConfiguredReviewAgent[];
  createAgentSession: GateExecutionContext["createAgentSession"];
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
  /** Tool ids active in the host runtime. Used to gate `peerCoordination` on `irc`. */
  activeTools?: string[];
  onAgentStart?: (agent: ConfiguredReviewAgent) => void;
  onAgentComplete?: (result: MultiAgentAgentResult) => void;
  reliability?: ReliabilityReporter;
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
  return renderTemplate(outputInstructionsPrompt, {
    outputSchema: REVIEW_OUTPUT_SCHEMA_TEXT,
  });
}

export function buildConfiguredAgentPrompt(agent: ConfiguredReviewAgent, scope: ReviewScope): string {
  if (!agent.prompt.includes("{output_instructions}")) {
    throw new Error(`Review agent ${agent.name} is missing the {output_instructions} placeholder.`);
  }

  const outputInstructions = renderOutputInstructions();
  const agentPrompt = renderTemplate(agent.prompt.replaceAll("{output_instructions}", "{{outputInstructions}}"),
  { outputInstructions },);

  return renderTemplate(agentReviewWrapperPrompt, {
    agent,
    agentPrompt,
    scope,
  });
}

interface PeerCoordinationIdentity {
  agent: ConfiguredReviewAgent;
  id: string;
  displayName: string;
}

const PEER_COORDINATION_AGENT_ID_PREFIX = "supi-review";

function normalizePeerCoordinationIdSegment(name: string, fallbackIndex: number): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `agent-${fallbackIndex + 1}`;
}

function normalizePeerCoordinationDisplayName(name: string, fallbackIndex: number): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  return normalized || `review-agent-${fallbackIndex + 1}`;
}

export function buildPeerCoordinationIdentities(
  agents: ConfiguredReviewAgent[],
): PeerCoordinationIdentity[] {
  const countsByBaseId = new Map<string, number>();
  return agents.map((agent, index) => {
    const segment = normalizePeerCoordinationIdSegment(agent.name, index);
    const baseId = `${PEER_COORDINATION_AGENT_ID_PREFIX}-${segment}`;
    const previousCount = countsByBaseId.get(baseId) ?? 0;
    countsByBaseId.set(baseId, previousCount + 1);
    return {
      agent,
      id: previousCount === 0 ? baseId : `${baseId}-${previousCount + 1}`,
      displayName: normalizePeerCoordinationDisplayName(agent.name, index),
    };
  });
}

/**
 * Build the IRC peer-coordination prompt block for one agent.
 *
 * Returns `null` when peer coordination is disabled, the host runtime does not
 * expose the `irc` tool, or the agent has no peers (single-agent run, or only
 * itself opted in).
 */
export function buildPeerCoordinationPromptBlock(
  agent: ConfiguredReviewAgent,
  peers: ConfiguredReviewAgent[],
  activeTools: string[],
  identities: PeerCoordinationIdentity[] = buildPeerCoordinationIdentities(peers),
): string | null {
  if (agent.peerCoordination !== true) return null;
  if (!activeTools.includes("irc")) return null;

  const self = identities.find((identity) => identity.agent === agent);
  if (!self) return null;

  const otherPeers = identities.filter(
    (identity) => identity.agent.peerCoordination === true && identity.agent !== agent,
  );
  if (otherPeers.length === 0) return null;

  return [
    "## IRC peer coordination",
    "",
    `You are running as \`${self.id}\` in a multi-agent review. Other reviewers also opted into peer coordination:`,
    ...otherPeers.map((peer) => `- \`${peer.id}\` — ${peer.displayName}`),
    "",
    "Use the OMP `irc` tool when continuing alone is wasteful or wrong:",
    "- Send a DM with `irc({ op: \"send\", to: \"<peer-id>\", message: \"...\" })` when you spot work a peer is already filing, when you need their finding for context, or when you would otherwise duplicate analysis.",
    "- Reply in plain prose. Do **NOT** send JSON status payloads. Do **NOT** quote the message you are replying to.",
    "- One DM is one round-trip. Do **NOT** follow up with \"did you get my message?\".",
    "- Use exactly the peer ids listed above. Do **NOT** invent ids from agent names, and do **NOT** broadcast unless you genuinely need every peer.",
    "- If a peer has already filed an equivalent finding, do **NOT** file a duplicate; defer to theirs.",
    "",
  ].join("\n");
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
  peers: ConfiguredReviewAgent[],
  peerIdentities: PeerCoordinationIdentity[],
): Promise<MultiAgentAgentResult> {
  input.onAgentStart?.(agent);

  const identity = peerIdentities.find((peer) => peer.agent === agent);
  const basePrompt = buildConfiguredAgentPrompt(agent, input.scope);
  const peerBlock = buildPeerCoordinationPromptBlock(
    agent,
    peers,
    input.activeTools ?? [],
    peerIdentities,
  );
  const prompt = peerBlock ? `${peerBlock}\n${basePrompt}` : basePrompt;

  const result = await runWithOutputValidation(input.createAgentSession, {
    cwd: input.cwd,
    prompt,
    schema: REVIEW_OUTPUT_SCHEMA_TEXT,
    parse(raw) {
      const output = parseReviewOutput(raw);
      return {
        output,
        error: output ? null : explainReviewOutputFailure(raw),
      };
    },
    model: agent.model ?? input.model,
    thinkingLevel: agent.thinkingLevel ?? input.thinkingLevel ?? null,
    ...(peerBlock && identity
      ? { agentId: identity.id, agentDisplayName: identity.displayName }
      : {}),
    timeoutMs: input.timeoutMs ?? 120_000,
    reliability: input.reliability,
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
  const peerIdentities = buildPeerCoordinationIdentities(input.agents);
  const results = await Promise.all(
    input.agents.map((agent) => runConfiguredAgent(input, agent, input.agents, peerIdentities)),
  );

  return {
    agents: results,
    output: aggregateAgentOutputs(results),
  };
}
