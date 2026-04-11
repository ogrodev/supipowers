import { stripMarkdownCodeFence } from "../../text.js";
import { runStructuredAgentSession } from "../ai-session.js";
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

interface AiReviewPayload {
  summary: string;
  issues: GateIssue[];
  recommendedStatus: AiReviewResult["status"];
}

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
    "Return JSON only with this exact shape:",
    '{"summary":"string","issues":[{"severity":"error|warning|info","message":"string","file":"optional string","line":"optional number","detail":"optional string"}],"recommendedStatus":"passed|failed|blocked"}',
    "",
    "Rules:",
    "- recommendedStatus must be 'failed' when you found actionable issues.",
    "- recommendedStatus may be 'blocked' only if review could not be completed truthfully.",
    "- Do not wrap the JSON in markdown fences.",
  ].join("\n");
}

function isGateIssue(value: unknown): value is GateIssue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as GateIssue).severity !== undefined &&
    ["error", "warning", "info"].includes((value as GateIssue).severity) &&
    typeof (value as GateIssue).message === "string" &&
    ((value as GateIssue).file === undefined || typeof (value as GateIssue).file === "string") &&
    ((value as GateIssue).line === undefined || typeof (value as GateIssue).line === "number") &&
    ((value as GateIssue).detail === undefined || typeof (value as GateIssue).detail === "string")
  );
}

function parseAiReviewPayload(raw: string): AiReviewPayload | null {
  try {
    const parsed = JSON.parse(stripMarkdownCodeFence(raw)) as Record<string, unknown>;

    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.issues) ||
      !parsed.issues.every(isGateIssue) ||
      !["passed", "failed", "blocked"].includes(String(parsed.recommendedStatus))
    ) {
      return null;
    }

    return {
      summary: parsed.summary,
      issues: parsed.issues,
      recommendedStatus: parsed.recommendedStatus as AiReviewPayload["recommendedStatus"],
    };
  } catch {
    return null;
  }
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
): Promise<AiReviewResult> {
  const sessionResult = await runStructuredAgentSession(context.createAgentSession, {
    cwd: context.cwd,
    prompt: buildAiReviewPrompt(context.scopeFiles, context.fileScope, depth),
    model: context.reviewModel?.model,
    thinkingLevel: context.reviewModel?.thinkingLevel ?? null,
    timeoutMs: 120_000,
  });

  if (sessionResult.status !== "ok") {
    return buildBlockedResult(sessionResult.error);
  }

  const parsed = parseAiReviewPayload(sessionResult.finalText);
  if (!parsed) {
    return buildBlockedResult("AI review returned invalid JSON.", {
      rawOutput: sessionResult.finalText,
    });
  }

  return {
    status: parsed.recommendedStatus,
    summary: parsed.summary,
    issues: parsed.issues,
    metadata: { depth },
  };
}
