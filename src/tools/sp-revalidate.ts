import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../config";
import { saveState, loadState } from "../storage/state-store";
import { evaluateReviewGate } from "../quality/review-gate";
import { evaluateTddGate } from "../quality/tdd-gate";
import { evaluateVerificationGate, formatRevalidationReport } from "../quality/verification-gate";
import type { RevalidationStage } from "../quality/types";

const RevalidateParams = Type.Object({
  scope: Type.Optional(
    Type.Union([
      Type.Literal("all"),
      Type.Literal("tdd"),
      Type.Literal("review"),
      Type.Literal("verification"),
    ]),
  ),
  stage: Type.Optional(
    Type.Union([
      Type.Literal("manual"),
      Type.Literal("pre_execute"),
      Type.Literal("post_execute"),
      Type.Literal("pre_finish"),
    ]),
  ),
});

function stageOrDefault(stage?: RevalidationStage): RevalidationStage {
  return stage ?? "manual";
}

export function registerSpRevalidateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "sp_revalidate",
    label: "Supipowers Revalidate",
    description:
      "Re-run Supipowers quality gates (tdd/review/verification) and report pass/warn/block with actionable next steps.",
    parameters: RevalidateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const state = loadState(ctx.cwd);
      const stage = stageOrDefault(params.stage as RevalidationStage | undefined);
      const scope = params.scope ?? "all";

      let text = "";
      let blocking = false;

      if (scope === "tdd") {
        const gate = evaluateTddGate(ctx.cwd, state, config.strictness, {
          requireExecutionEvidence: stage === "post_execute" || stage === "pre_finish",
        });
        blocking = gate.blocking;
        text = [
          `Supipowers revalidation (${stage})`,
          `Strictness: ${config.strictness}`,
          `Gate: tdd`,
          `Result: ${gate.passed ? "PASS" : gate.blocking ? "BLOCK" : "WARN"}`,
          ...gate.issues.map((issue) => `- ${issue.message}${issue.recommendation ? `\n  ↳ ${issue.recommendation}` : ""}`),
        ].join("\n");
      } else if (scope === "review") {
        const gate = evaluateReviewGate(ctx.cwd, state, config.strictness, {
          requireReviewPass: stage === "pre_finish",
          requireRunSummary: stage !== "pre_execute",
        });
        blocking = gate.blocking;
        text = [
          `Supipowers revalidation (${stage})`,
          `Strictness: ${config.strictness}`,
          `Gate: review`,
          `Result: ${gate.passed ? "PASS" : gate.blocking ? "BLOCK" : "WARN"}`,
          ...gate.issues.map((issue) => `- ${issue.message}${issue.recommendation ? `\n  ↳ ${issue.recommendation}` : ""}`),
        ].join("\n");
      } else {
        const report = evaluateVerificationGate({
          cwd: ctx.cwd,
          state,
          strictness: config.strictness,
          stage,
        });
        blocking = report.blocking;
        text = formatRevalidationReport(report);
      }

      const nextState = {
        ...state,
        blocker: blocking ? "Quality gates reported blocking issues." : undefined,
        nextAction: blocking
          ? "Run sp_revalidate and follow remediation steps before continuing."
          : state.nextAction,
        updatedAt: Date.now(),
      };
      saveState(ctx.cwd, nextState);

      return {
        content: [{ type: "text" as const, text }],
        isError: blocking,
        details: { blocking, stage, scope },
      };
    },
  });
}
