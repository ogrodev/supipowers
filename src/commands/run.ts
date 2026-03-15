import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { resolveProfile } from "../config/profiles.js";
import { listPlans, readPlanFile, parsePlan } from "../storage/plans.js";
import {
  generateRunId,
  createRun,
  updateRun,
  findActiveRun,
  saveAgentResult,
  loadAllAgentResults,
} from "../storage/runs.js";
import { scheduleBatches } from "../orchestrator/batch-scheduler.js";
import { dispatchAgent, dispatchAgentWithReview, dispatchFixAgent } from "../orchestrator/dispatcher.js";
import { summarizeBatch, buildRunSummary } from "../orchestrator/result-collector.js";
import { analyzeConflicts } from "../orchestrator/conflict-resolver.js";
import { isLspAvailable } from "../lsp/detector.js";
import { detectContextMode } from "../context-mode/detector.js";
import {
  notifyInfo,
  notifySuccess,
  notifyWarning,
  notifyError,
  notifySummary,
} from "../notifications/renderer.js";
import { buildWorktreePrompt } from "../git/worktree.js";
import { buildBranchFinishPrompt } from "../git/branch-finish.js";
import type { RunManifest, AgentResult } from "../types.js";

export function registerRunCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:run", {
    description: "Execute a plan with sub-agent orchestration",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);
      const profile = resolveProfile(ctx.cwd, config, args?.replace("--profile ", "") || undefined);

      let manifest = findActiveRun(ctx.cwd);
      let branchName: string | null = null;

      if (!manifest) {
        const plans = listPlans(ctx.cwd);
        if (plans.length === 0) {
          notifyError(ctx, "No plans found", "Run /supi:plan first to create a plan");
          return;
        }

        const planName = args?.trim() || plans[0];
        const planContent = readPlanFile(ctx.cwd, planName);
        if (!planContent) {
          notifyError(ctx, "Plan not found", planName);
          return;
        }

        const plan = parsePlan(planContent, planName);
        const batches = scheduleBatches(plan.tasks, config.orchestration.maxParallelAgents);

        manifest = {
          id: generateRunId(),
          planRef: planName,
          profile: profile.name,
          status: "running",
          startedAt: new Date().toISOString(),
          batches,
        };
        createRun(ctx.cwd, manifest);
        notifyInfo(ctx, `Run started: ${manifest.id}`, `${plan.tasks.length} tasks in ${batches.length} batches`);

        // Offer worktree setup for isolated execution
        if (ctx.hasUI) {
          const useWorktree = await ctx.ui.select(
            "Execution isolation",
            [
              "Run in current workspace",
              "Create isolated worktree (recommended)",
            ],
            { helpText: "Worktrees prevent work-in-progress from polluting your workspace" },
          );
          if (!useWorktree) return;

          if (useWorktree.startsWith("Create isolated")) {
            branchName = `supi/${plan.name || manifest.id}`;
            const worktreeInstructions = buildWorktreePrompt({
              branchName,
              cwd: ctx.cwd,
            });
            pi.sendMessage(
              {
                customType: "supi-worktree-setup",
                content: [{ type: "text", text: worktreeInstructions }],
                display: "none",
              },
              { deliverAs: "steer" },
            );
            notifyInfo(ctx, "Setting up worktree", `Branch: ${branchName}`);
          }
        }
      } else {
        notifyInfo(ctx, `Resuming run: ${manifest.id}`);
      }

      const planContent = readPlanFile(ctx.cwd, manifest.planRef);
      if (!planContent) {
        notifyError(ctx, "Plan file missing", manifest.planRef);
        return;
      }
      const plan = parsePlan(planContent, manifest.planRef);
      const lsp = isLspAvailable(pi.getActiveTools());
      const ctxMode = detectContextMode(pi.getActiveTools()).available;

      for (const batch of manifest.batches) {
        if (batch.status === "completed") continue;

        batch.status = "running";
        updateRun(ctx.cwd, manifest);

        notifyInfo(
          ctx,
          `Batch ${batch.index + 1}/${manifest.batches.length}`,
          `${batch.taskIds.length} tasks`
        );

        const batchResults: AgentResult[] = [];
        const agentPromises = batch.taskIds.map((taskId) => {
          const task = plan.tasks.find((t) => t.id === taskId);
          if (!task) return Promise.resolve(null);

          return dispatchAgentWithReview({
            pi,
            ctx,
            task,
            planContext: plan.context,
            config,
            lspAvailable: lsp,
            contextModeAvailable: ctxMode,
          });
        });

        const results = await Promise.all(agentPromises);
        for (const result of results) {
          if (result) {
            batchResults.push(result);
            saveAgentResult(ctx.cwd, manifest.id, result);
          }
        }

        const conflicts = analyzeConflicts(batchResults, plan.tasks, ctxMode);
        if (conflicts.hasConflicts) {
          notifyWarning(
            ctx,
            "File conflicts detected",
            conflicts.conflictingFiles.join(", ")
          );
        }

        const failedResults = batchResults.filter((r) => r.status === "blocked");
        for (const failed of failedResults) {
          if (config.orchestration.maxFixRetries > 0) {
            const task = plan.tasks.find((t) => t.id === failed.taskId);
            if (!task) continue;

            for (let retry = 0; retry < config.orchestration.maxFixRetries; retry++) {
              notifyInfo(ctx, `Retrying task ${failed.taskId}`, `attempt ${retry + 1}`);
              const fixResult = await dispatchFixAgent({
                pi,
                ctx,
                task,
                planContext: plan.context,
                config,
                lspAvailable: lsp,
                contextModeAvailable: ctxMode,
                previousOutput: failed.output,
                failureReason: failed.output,
              });
              saveAgentResult(ctx.cwd, manifest.id, fixResult);
              if (fixResult.status !== "blocked") break;
            }
          }
        }

        const allResults = loadAllAgentResults(ctx.cwd, manifest.id);
        const summary = summarizeBatch(batch, allResults);

        batch.status = summary.allPassed ? "completed" : "failed";
        updateRun(ctx.cwd, manifest);

        if (!summary.allPassed) {
          notifyWarning(
            ctx,
            `Batch ${batch.index + 1} had issues`,
            `${summary.blocked} blocked, ${summary.doneWithConcerns} with concerns`
          );
        }
      }

      const allResults = loadAllAgentResults(ctx.cwd, manifest.id);
      const runSummary = buildRunSummary(allResults);

      manifest.status = runSummary.blocked > 0 ? "failed" : "completed";
      manifest.completedAt = new Date().toISOString();
      updateRun(ctx.cwd, manifest);

      const durationSec = Math.round(runSummary.totalDuration / 1000);
      notifySummary(
        ctx,
        "Run complete",
        `${runSummary.done + runSummary.doneWithConcerns}/${runSummary.totalTasks} tasks done ` +
        `(${runSummary.done} clean, ${runSummary.doneWithConcerns} with concerns, ` +
        `${runSummary.blocked} blocked) | ${runSummary.totalFilesChanged} files | ${durationSec}s`
      );

      // Offer branch finish options if we created a worktree branch
      if (branchName && manifest.status === "completed") {
        const finishInstructions = buildBranchFinishPrompt({
          branchName,
          baseBranch: "main",
        });
        pi.sendMessage(
          {
            customType: "supi-branch-finish",
            content: [{ type: "text", text: finishInstructions }],
            display: "none",
          },
          { deliverAs: "steer" },
        );
        notifyInfo(ctx, "Run succeeded", "Follow branch finish instructions to integrate your work");
      }
    },
  });
}
