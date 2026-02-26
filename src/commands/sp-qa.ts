import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { appendWorkflowEvent } from "../storage/events-log";
import { getRuntime } from "./shared";
import { parseCommandLines, parseQaArgs } from "../qa/input";
import { buildMatrixPreview, buildQaMatrix } from "../qa/matrix";
import { runQaMatrixWithPlaywright } from "../qa/playwright-runner";
import { buildQaFindingsReport, deriveQaRecommendation } from "../qa/report";
import {
  createQaRunWorkspace,
  ensureQaStorageGitignored,
  loadQaAuthProfile,
  saveQaAuthProfile,
  writeQaMatrix,
} from "../qa/storage";
import type { QaCaseResult, QaVerdict } from "../qa/types";

const UNSTABLE_PHASES = new Set([
  "brainstorming",
  "design_pending_approval",
  "design_approved",
  "planning",
  "plan_ready",
  "executing",
]);

async function askForValue(
  hasUI: boolean,
  input: ((title: string, placeholder?: string) => Promise<string | undefined>) | undefined,
  title: string,
  placeholder?: string,
): Promise<string> {
  if (!hasUI || !input) return "";
  return ((await input(title, placeholder)) ?? "").trim();
}

function normalizeVerdict(value: string | undefined): QaVerdict | undefined {
  if (value === "APPROVE" || value === "REFUSE" || value === "PENDING_DECISION") return value;
  return undefined;
}

function fatalAsResult(error: string): QaCaseResult {
  const now = new Date().toISOString();
  return {
    caseId: "QA-FATAL",
    title: "QA runner setup",
    severity: "high",
    passed: false,
    startedAt: now,
    finishedAt: now,
    error,
    screenshots: [],
    commands: [],
  };
}

export function registerSpQaCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-qa", {
    description: "Run QA matrix with playwright-cli, collect screenshots, and write findings",
    async handler(args, ctx) {
      const { state } = getRuntime(ctx);

      let unstablePhaseWarning: string | undefined;
      if (UNSTABLE_PHASES.has(state.phase)) {
        unstablePhaseWarning =
          `Workflow phase '${state.phase}' may still be changing. QA findings can be inconsistent until implementation stabilizes.`;
        if (ctx.hasUI) {
          ctx.ui.notify(unstablePhaseWarning, "warning");
        }
      }

      const gitignoreStatus = ensureQaStorageGitignored(ctx.cwd);
      if (ctx.hasUI && gitignoreStatus.updated) {
        ctx.ui.notify("Added '.pi/' to .gitignore to keep QA evidence and local auth out of git.", "info");
      }

      const parsed = parseQaArgs(args, ctx.cwd);
      const authProfile = loadQaAuthProfile(ctx.cwd);

      let workflow = parsed.workflow?.trim() ?? "";
      if (!workflow) {
        workflow = await askForValue(
          ctx.hasUI,
          ctx.ui?.input.bind(ctx.ui),
          "Workflow under test",
          state.objective ?? "e.g. checkout flow for existing users",
        );
      }

      if (!workflow) {
        if (ctx.hasUI) {
          ctx.ui.notify("QA run requires workflow context. Try: /sp-qa <workflow description>", "error");
        }
        return;
      }

      let targetUrl = parsed.targetUrl?.trim() ?? authProfile?.targetUrl ?? "";
      if (!targetUrl) {
        targetUrl = await askForValue(
          ctx.hasUI,
          ctx.ui?.input.bind(ctx.ui),
          "Target URL",
          "http://localhost:3000",
        );
      }

      if (!targetUrl) {
        if (ctx.hasUI) {
          ctx.ui.notify("QA run requires a target URL. Use --url <value> or provide it when prompted.", "error");
        }
        return;
      }

      let authSetupCommands = authProfile?.authSetupCommands ?? [];
      let reuseSavedAuth = authProfile !== undefined;

      if (ctx.hasUI && authProfile && authProfile.authSetupCommands.length > 0) {
        reuseSavedAuth = await ctx.ui.confirm(
          "Reuse saved QA auth setup",
          `Saved auth setup found for ${authProfile.targetUrl}. Reuse it for this run?`,
        );
      }

      if (!reuseSavedAuth || authSetupCommands.length === 0 || authProfile?.targetUrl !== targetUrl) {
        const authRaw = await askForValue(
          ctx.hasUI,
          ctx.ui?.input.bind(ctx.ui),
          "Auth setup commands for playwright-cli (optional, ';' separated)",
          authSetupCommands.join("; "),
        );

        authSetupCommands = parseCommandLines(authRaw);
      }

      saveQaAuthProfile(ctx.cwd, {
        targetUrl,
        authSetupCommands,
        updatedAt: Date.now(),
      });

      const happyRaw = await askForValue(
        ctx.hasUI,
        ctx.ui?.input.bind(ctx.ui),
        "Happy-path playwright-cli commands (optional, ';' separated)",
        "",
      );
      const negativeRaw = await askForValue(
        ctx.hasUI,
        ctx.ui?.input.bind(ctx.ui),
        "Negative-path commands (optional, ';' separated)",
        "",
      );
      const edgeRaw = await askForValue(
        ctx.hasUI,
        ctx.ui?.input.bind(ctx.ui),
        "Edge-case commands (optional, ';' separated)",
        "",
      );
      const notes = await askForValue(
        ctx.hasUI,
        ctx.ui?.input.bind(ctx.ui),
        "Extra QA notes/constraints (optional)",
        "",
      );

      const matrix = buildQaMatrix({
        workflow,
        targetUrl,
        contextNotes: notes || undefined,
        happyPathCommands: parseCommandLines(happyRaw),
        negativePathCommands: parseCommandLines(negativeRaw),
        edgePathCommands: parseCommandLines(edgeRaw),
      });

      const run = createQaRunWorkspace(ctx.cwd);
      writeQaMatrix(run.matrixPath, matrix);

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "qa_matrix_prepared",
        phase: state.phase,
        meta: {
          runId: run.runId,
          matrixPath: run.matrixPathRelative,
          workflowSource: parsed.workflowSource,
          workflowFilePath: parsed.workflowFilePath,
        },
      });

      const preview = buildMatrixPreview(matrix);
      if (ctx.hasUI) {
        ctx.ui.notify(`QA matrix prepared at ${run.matrixPathRelative}\n${preview}`, "info");
      }

      const shouldRun = ctx.hasUI
        ? await ctx.ui.confirm(
          "Run QA matrix",
          `${preview}\n\nRun QA execution now? Screenshots and findings will be stored under ${run.runDirRelative}.`,
        )
        : true;

      if (!shouldRun) {
        if (ctx.hasUI) {
          ctx.ui.notify(`QA matrix saved. Run /sp-qa again when you want to execute.`, "info");
        }
        return;
      }

      const startedAt = new Date().toISOString();
      const execution = await runQaMatrixWithPlaywright(pi, ctx, {
        matrix,
        run,
        authSetupCommands,
      });

      const results = execution.fatalError ? [fatalAsResult(execution.fatalError)] : execution.results;
      const recommendation = deriveQaRecommendation(results);

      let finalVerdict: QaVerdict = recommendation;
      if (ctx.hasUI) {
        const accepted = await ctx.ui.confirm(
          "QA verdict recommendation",
          `Recommendation: ${recommendation}. Apply this final verdict?`,
        );

        if (!accepted) {
          const selected = normalizeVerdict(
            await ctx.ui.select("Choose final QA verdict", ["APPROVE", "REFUSE", "PENDING_DECISION"]),
          );
          finalVerdict = selected ?? "PENDING_DECISION";
        }
      }

      const summary = {
        runId: run.runId,
        workflow,
        targetUrl,
        unstablePhaseWarning,
        recommendation,
        finalVerdict,
        startedAt,
        finishedAt: new Date().toISOString(),
        matrix,
        results,
        notesFilePath: run.findingsPathRelative,
      };

      const findings = buildQaFindingsReport(summary);
      writeFileSync(run.findingsPath, findings, "utf-8");

      appendWorkflowEvent(ctx.cwd, {
        ts: Date.now(),
        type: "qa_run_completed",
        phase: state.phase,
        meta: {
          runId: run.runId,
          verdict: finalVerdict,
          recommendation,
          findingsPath: run.findingsPathRelative,
          failedCases: results.filter((item) => !item.passed).length,
        },
      });

      if (ctx.hasUI) {
        ctx.ui.notify(
          [
            `QA run ${run.runId} finished.`,
            `Final verdict: ${finalVerdict} (recommendation: ${recommendation}).`,
            `Artifacts: ${run.runDirRelative}`,
            `Findings: ${run.findingsPathRelative}`,
          ].join("\n"),
          finalVerdict === "APPROVE" ? "info" : "warning",
        );
      }
    },
  });
}
