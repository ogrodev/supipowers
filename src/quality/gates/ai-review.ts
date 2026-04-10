import { GATE_CONFIG_SCHEMAS } from "../registry.js";
import { runStructuredAgentSession } from "../ai-session.js";
import type {
  AiReviewGateConfig,
  GateDefinition,
  GateIssue,
  GateStatus,
  GateResult,
  ProjectFacts,
} from "../../types.js";

interface AiReviewPayload {
  summary: string;
  issues: GateIssue[];
  recommendedStatus: Extract<GateStatus, "passed" | "failed" | "blocked">;
}

function buildAiReviewPrompt(
  scopeFiles: string[],
  fileScope: "changed-files" | "all-files",
  depth: AiReviewGateConfig["depth"],
): string {
  const scopeLabel = fileScope === "changed-files" ? "changed files" : "repository files";
  const files = scopeFiles.length > 0 ? scopeFiles.map((file) => `- ${file}`).join("\n") : "- (no files reported)";
  const depthInstructions =
    depth === "quick"
      ? "Focus on obvious correctness, security, and maintainability issues."
      : "Review deeply for correctness, edge cases, security, maintainability, and missing validation.";

  return [
    "You are running a structured code review quality gate.",
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

function normalizeJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length >= 3 && lines[0].startsWith("```") && lines[lines.length - 1] === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }

  return trimmed;
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
    const parsed = JSON.parse(normalizeJsonText(raw)) as Record<string, unknown>;

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

function buildBlockedResult(summary: string, metadata?: Record<string, unknown>): GateResult {
  return {
    gate: "ai-review",
    status: "blocked",
    summary,
    issues: [],
    ...(metadata ? { metadata } : {}),
  };
}

export const aiReviewGate: GateDefinition<AiReviewGateConfig> = {
  id: "ai-review",
  description: "Runs a structured AI review over the selected scope.",
  configSchema: GATE_CONFIG_SCHEMAS["ai-review"],
  detect(_projectFacts: ProjectFacts) {
    return {
      suggestedConfig: { enabled: true, depth: "deep" },
      confidence: "medium",
      reason: "AI review is the default human-readable gate.",
    };
  },
  async run(context, config) {
    const sessionResult = await runStructuredAgentSession(context.createAgentSession, {
      cwd: context.cwd,
      prompt: buildAiReviewPrompt(context.scopeFiles, context.fileScope, config.depth),
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
      gate: "ai-review",
      status: parsed.recommendedStatus,
      summary: parsed.summary,
      issues: parsed.issues,
      metadata: { depth: config.depth },
    };
  },
};
