import { parseStructuredOutput, runWithOutputValidation, type ReliabilityReporter } from "../../ai/structured-output.js";
import { renderSchemaText } from "../../ai/schema-text.js";
import { AiReviewOutputSchema, type AiReviewOutput } from "../contracts.js";
import type {
  GateExecutionContext,
  GateIssue,
  GateStatus,
} from "../../types.js";

export type AiReviewDepth = "quick" | "deep";

export interface AiReviewResult {
  status: Extract<GateStatus, "passed" | "failed" | "blocked">;
  summary: string;
  issues: GateIssue[];
  metadata?: Record<string, unknown>;
}

const AI_REVIEW_SCHEMA_TEXT = renderSchemaText(AiReviewOutputSchema);

export function buildAiReviewPrompt(
  scopeFiles: string[],
  fileScope: "changed-files" | "all-files",
  depth: AiReviewDepth,
): string {
  const scopeLabel = fileScope === "changed-files" ? "changed files" : "repository files";
  const files = scopeFiles.length > 0 ? scopeFiles.map((file) => `- ${file}`).join("\n") : "- (no files reported)";
  const depthInstructions =
    depth === "quick"
      ? "Focus on obvious correctness, security, and maintainability issues."
      : "Review deeply for correctness, edge cases, security, maintainability, and missing validation.";

  return [
    "You are running a structured code review pass.",
    `Scope: ${scopeLabel}.`,
    `Depth: ${depth}.`,
    depthInstructions,
    "",
    "Files in scope:",
    files,
    "",
    "Return JSON only matching this schema:",
    AI_REVIEW_SCHEMA_TEXT,
    "",
    "Rules:",
    "- recommendedStatus must be 'failed' when you found actionable issues.",
    "- recommendedStatus may be 'blocked' only if review could not be completed truthfully.",
    "- Do not wrap the JSON in markdown fences.",
  ].join("\n");
}

function buildBlockedResult(summary: string, metadata?: Record<string, unknown>): AiReviewResult {
  return {
    status: "blocked",
    summary,
    issues: [],
    ...(metadata ? { metadata } : {}),
  };
}

export async function runAiReview(
  context: Pick<GateExecutionContext, "cwd" | "scopeFiles" | "fileScope" | "createAgentSession" | "reviewModel">,
  depth: AiReviewDepth,
  reliability?: ReliabilityReporter,
): Promise<AiReviewResult> {
  const result = await runWithOutputValidation<AiReviewOutput>(context.createAgentSession, {
    cwd: context.cwd,
    prompt: buildAiReviewPrompt(context.scopeFiles, context.fileScope, depth),
    schema: AI_REVIEW_SCHEMA_TEXT,
    parse: (raw) => parseStructuredOutput<AiReviewOutput>(raw, AiReviewOutputSchema),
    model: context.reviewModel?.model,
    thinkingLevel: context.reviewModel?.thinkingLevel ?? null,
    timeoutMs: 120_000,
    reliability,
  });

  if (result.status === "blocked") {
    return buildBlockedResult(result.error, {
      depth,
      attempts: result.attempts,
      ...(result.rawOutputs.length > 0 ? { rawOutputs: result.rawOutputs } : {}),
    });
  }

  return {
    status: result.output.recommendedStatus,
    summary: result.output.summary,
    issues: result.output.issues as GateIssue[],
    metadata: { depth, attempts: result.attempts },
  };
}
