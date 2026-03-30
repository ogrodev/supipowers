import type { Platform } from "../platform/types.js";
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
import { dispatchAgentWithReview, dispatchFixAgent } from "../orchestrator/dispatcher.js";
import { summarizeBatch, buildRunSummary } from "../orchestrator/result-collector.js";
import { analyzeConflicts } from "../orchestrator/conflict-resolver.js";
import { isLspAvailable } from "../lsp/detector.js";
import { detectContextMode } from "../context-mode/detector.js";
import {
  notifyInfo,
  notifyWarning,
  notifyError,
  notifySummary,
} from "../notifications/renderer.js";
import { buildWorktreePrompt } from "../git/worktree.js";
import { buildBranchFinishPrompt } from "../git/branch-finish.js";
import { detectBaseBranch } from "../git/base-branch.js";
import type { AgentResult } from "../types.js";
import { RunProgressState, activeRuns } from "../orchestrator/run-progress.js";
import { InlineProgressComponent } from "../orchestrator/progress-renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";

modelRegistry.register({
  id: "run",
  category: "command",
  label: "Run",
  harnessRoleHint: "default",
});

interface ParsedRunArgs {
  profile?: string;
  plan?: string;
}

export function parseRunArgs(args: string | undefined): ParsedRunArgs {
  if (!args) return {};
  const result: ParsedRunArgs = {};
  const profileMatch = args.match(/--profile\s+(\S+)/);
  if (profileMatch && !profileMatch[1].startsWith("--")) {
    result.profile = profileMatch[1];
  }
  const planMatch = args.match(/--plan\s+(\S+)/);
  if (planMatch && !planMatch[1].startsWith("--")) {
    result.plan = planMatch[1];
  }
  // If no flags were matched, treat the whole string as a plan name (backwards compat)
  if (!result.profile && !result.plan) {
    const trimmed = args.trim();
    if (trimmed && !trimmed.startsWith("--")) result.plan = trimmed;
  }
  return result;
}

export function formatAge(isoDate: string): string {
  const ms = Math.max(0, Date.now() - new Date(isoDate).getTime());
  if (Number.isNaN(ms)) return "unknown";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function registerRunCommand(platform: Platform): void {
  platform.registerCommand("supi:run", {
    description: "Execute a plan with sub-agent orchestration",
    async handler(args: string | undefined, ctx: any) {
      const config = loadConfig(platform.paths, ctx.cwd);
      const parsed = parseRunArgs(args);
      const profile = resolveProfile(platform.paths, ctx.cwd, config, parsed.profile);

      let manifest = findActiveRun(platform.paths, ctx.cwd);
      let branchName: string | null = null;

      // Handle active run: prompt user to resume or start fresh
      if (manifest) {
        if (ctx.hasUI) {
          const age = formatAge(manifest.startedAt);
          const choice = await ctx.ui.select(
            `Found active run ${manifest.id} for plan '${manifest.planRef}' (started ${age} ago)`,
            ["Resume", "Start fresh"],
          );
          if (!choice) return;

          if (choice === "Start fresh") {
            manifest.status = "cancelled";
            manifest.completedAt = new Date().toISOString();
            updateRun(platform.paths, ctx.cwd, manifest);
            manifest = null;
          } else {
            const completedBatches = manifest.batches.filter((b) => b.status === "completed").length;
            const totalBatches = manifest.batches.length;
            const completedTasks = manifest.batches
              .filter((b) => b.status === "completed")
              .reduce((sum, b) => sum + b.taskIds.length, 0);
            const totalTasks = manifest.batches.reduce((sum, b) => sum + b.taskIds.length, 0);
            notifyInfo(
              ctx,
              `Resuming run: ${manifest.id}`,
              `${completedTasks}/${totalTasks} tasks done, ${completedBatches}/${totalBatches} batches completed`,
            );
          }
        } else {
          // No UI — resume automatically
          notifyInfo(ctx, `Resuming run: ${manifest.id}`);
        }
      }

      // Create a new run if no active run or user chose "Start fresh"
      if (!manifest) {
        const plans = listPlans(platform.paths, ctx.cwd);
        if (plans.length === 0) {
          notifyError(ctx, "No plans found", "Run /supi:plan first to create a plan");
          return;
        }

        const planName = parsed.plan || plans[0];
        notifyInfo(ctx, "Using plan", planName);
        const planContent = readPlanFile(platform.paths, ctx.cwd, planName);
        if (!planContent) {
          notifyError(ctx, "Plan not found", planName);
          return;
        }

        const plan = parsePlan(planContent, planName);
        if (plan.tasks.length === 0) {
          notifyError(
            ctx,
            "No tasks found in plan",
            "Task headers must use '### N. Name' or '### Task N: Name' format",
          );
          return;
        }
        const batches = scheduleBatches(plan.tasks, config.orchestration.maxParallelAgents);

        manifest = {
          id: generateRunId(),
          planRef: planName,
          profile: profile.name,
          status: "running",
          startedAt: new Date().toISOString(),
          batches,
        };
        createRun(platform.paths, ctx.cwd, manifest);
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
            platform.sendMessage(
              {
                customType: "supi-worktree-setup",
                content: [{ type: "text", text: worktreeInstructions }],
                display: "none",
              },
              { deliverAs: "steer", triggerTurn: true },
            );
            notifyInfo(ctx, "Setting up worktree", `Branch: ${branchName}`);
          }
        }
      }

      const planContent = readPlanFile(platform.paths, ctx.cwd, manifest.planRef);
      if (!planContent) {
        notifyError(ctx, "Plan file missing", manifest.planRef);
        return;
      }
      const plan = parsePlan(planContent, manifest.planRef);
      const lsp = isLspAvailable(platform.getActiveTools());
      const ctxMode = detectContextMode(platform.getActiveTools()).available;

      // Capture the parent session's model as ultimate fallback for sub-agents
      const rawModel = ctx.model?.id ?? platform.getCurrentModel?.();
      const parentSessionModel = rawModel && rawModel !== "unknown" ? rawModel : undefined;

      // Create shared progress state and send inline progress message
      const progress = new RunProgressState();
      for (const task of plan.tasks) {
        const deps = task.parallelism.type === "sequential" ? task.parallelism.dependsOn : [];
        progress.addTask(task.id, task.name, deps);
      }
      // On resume, mark already-completed tasks
      const existingResults = loadAllAgentResults(platform.paths, ctx.cwd, manifest!.id);
      for (const result of existingResults) {
        if (result.status === "done") {
          progress.setStatus(result.taskId, "done");
        } else if (result.status === "done_with_concerns") {
          progress.setStatus(result.taskId, "done_with_concerns", result.concerns);
        } else if (result.status === "blocked") {
          progress.setStatus(result.taskId, "blocked", result.output);
        }
      }
      activeRuns.set(manifest.id, progress);

      // Set up widget above input for live progress (colored, animated)
      const WIDGET_KEY = "supi-run-progress";
      const setProgressWidget = () => {
        ctx.ui?.setWidget?.(WIDGET_KEY, (_tui: any, theme: any) =>
          new InlineProgressComponent(manifest.id, theme),
        );
      };
      const clearWidget = () => ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
      progress.onChange = setProgressWidget;
      progress.signal.addEventListener("abort", clearWidget);
      setProgressWidget();

      try {
      // Track tasks that failed across batches to cascade-block dependents
      const failedTaskIds = new Set<number>();

      for (const batch of manifest.batches) {
        if (batch.status === "completed") continue;

        // Check for user interrupt (ESC) before starting each batch
        if (progress.aborted) {
          notifyWarning(ctx, "Run interrupted", "Stopping before next batch");
          break;
        }

        // Cascade-block: skip tasks whose dependencies failed in earlier batches
        const executableTaskIds: number[] = [];
        const cascadeBlocked: number[] = [];
        for (const taskId of batch.taskIds) {
          const task = plan.tasks.find((t) => t.id === taskId);
          if (!task) continue;
          if (
            task.parallelism.type === "sequential" &&
            task.parallelism.dependsOn.some((dep) => failedTaskIds.has(dep))
          ) {
            cascadeBlocked.push(taskId);
          } else {
            executableTaskIds.push(taskId);
          }
        }

        // Mark cascade-blocked tasks and save their results
        for (const taskId of cascadeBlocked) {
          const task = plan.tasks.find((t) => t.id === taskId);
          const blockedResult: AgentResult = {
            taskId,
            status: "blocked",
            output: "Skipped: dependency task failed in a previous batch",
            filesChanged: [],
            duration: 0,
          };
          failedTaskIds.add(taskId);
          progress.setStatus(taskId, "blocked", blockedResult.output);
          saveAgentResult(platform.paths, ctx.cwd, manifest.id, blockedResult);
          notifyWarning(ctx, `Task ${taskId} skipped`, `Dependency failed — ${task?.name ?? "unknown"}`);
        }

        // If all tasks in this batch were cascade-blocked, mark batch failed and continue
        if (executableTaskIds.length === 0) {
          batch.status = "failed";
          updateRun(platform.paths, ctx.cwd, manifest);
          notifyWarning(
            ctx,
            `Batch ${batch.index + 1} skipped`,
            `All ${cascadeBlocked.length} tasks blocked by earlier failures`
          );
          continue;
        }

        // Filter out already-completed tasks (for resume of partially-done batches)
        const existingResults = loadAllAgentResults(platform.paths, ctx.cwd, manifest.id);
        const completedTaskIds = new Set(
          existingResults
            .filter(r => r.status === "done" || r.status === "done_with_concerns")
            .map(r => r.taskId)
        );
        const tasksToDispatch = executableTaskIds.filter(id => !completedTaskIds.has(id));
        const skippedResumeCount = executableTaskIds.length - tasksToDispatch.length;
        if (skippedResumeCount > 0) {
          notifyInfo(ctx, `Skipping ${skippedResumeCount} already-completed tasks`);
        }

        // If all tasks already completed on resume, mark batch done and continue
        if (tasksToDispatch.length === 0 && executableTaskIds.length > 0) {
          batch.status = "completed";
          updateRun(platform.paths, ctx.cwd, manifest);
          notifyInfo(ctx, `Batch ${batch.index + 1} already completed on previous run`);
          continue;
        }

        batch.status = "running";
        updateRun(platform.paths, ctx.cwd, manifest);

        notifyInfo(
          ctx,
          `Batch ${batch.index + 1}/${manifest.batches.length}`,
          `${tasksToDispatch.length} tasks${cascadeBlocked.length > 0 ? ` (${cascadeBlocked.length} cascade-blocked)` : ""}${skippedResumeCount > 0 ? ` (${skippedResumeCount} already done)` : ""}`
        );
        progress.batchLabel = `Batch ${batch.index + 1}/${manifest.batches.length}`;

        // Compose per-task timeout signal with user interrupt signal
        const taskSignal = config.orchestration.taskTimeout > 0
          ? AbortSignal.any([
              progress.signal,
              AbortSignal.timeout(config.orchestration.taskTimeout),
            ])
          : progress.signal;

        const batchResults: AgentResult[] = [];
        const agentPromises = tasksToDispatch.map((taskId) => {
          const task = plan.tasks.find((t) => t.id === taskId);
          if (!task) return Promise.resolve(null);

          return dispatchAgentWithReview({
            platform,
            ctx,
            task,
            planContext: plan.context,
            config,
            lspAvailable: lsp,
            contextModeAvailable: ctxMode,
            progress,
            signal: taskSignal,
            parentSessionModel,
          }).catch((error: unknown): AgentResult => {
            const msg = error instanceof Error ? error.message : String(error);
            progress.setStatus(taskId, "blocked", `Unexpected error: ${msg}`);
            notifyError(ctx, `Task ${taskId} crashed`, msg);
            return {
              taskId,
              status: "blocked",
              output: `Unexpected dispatch error: ${msg}`,
              filesChanged: [],
              duration: 0,
            };
          });
        });

        // Race agent dispatch against abort signal
        const abortPromise = new Promise<"aborted">((resolve) => {
          if (progress.aborted) { resolve("aborted"); return; }
          progress.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        });
        const raceResult = await Promise.race([
          Promise.all(agentPromises).then((r) => ({ type: "results" as const, results: r })),
          abortPromise.then(() => ({ type: "aborted" as const })),
        ]);

        if (raceResult.type === "aborted") {
          notifyWarning(ctx, "Run interrupted by user", "Saving progress...");
          batch.status = "pending"; // revert so it can be resumed
          updateRun(platform.paths, ctx.cwd, manifest);
          break;
        }

        for (const result of raceResult.results) {
          if (result) {
            batchResults.push(result);
            saveAgentResult(platform.paths, ctx.cwd, manifest.id, result);
          }
        }

        const conflicts = analyzeConflicts(batchResults, plan.tasks, ctxMode);
        if (conflicts.hasConflicts) {
          notifyWarning(
            ctx,
            "File conflicts detected",
            conflicts.conflictingFiles.join(", ")
          );
          if (conflicts.mergePrompt) {
            platform.sendMessage(
              {
                customType: "supi-conflict-resolution",
                content: [{ type: "text", text: conflicts.mergePrompt }],
                display: "none",
              },
              { deliverAs: "steer", triggerTurn: true },
            );
          }
        }

        // Skip fix retries if interrupted
        if (progress.aborted) break;

        const failedResults = batchResults.filter((r) => r.status === "blocked");
        for (const failed of failedResults) {
          if (config.orchestration.maxFixRetries > 0) {
            const task = plan.tasks.find((t) => t.id === failed.taskId);
            if (!task) continue;

            let fixed = false;
            let latestResult: AgentResult = failed;
            for (let retry = 0; retry < config.orchestration.maxFixRetries; retry++) {
              if (progress.aborted) break;
              notifyInfo(ctx, `Retrying task ${failed.taskId}`, `attempt ${retry + 1}`);
              const fixResult = await dispatchFixAgent({
                platform,
                ctx,
                task,
                planContext: plan.context,
                config,
                lspAvailable: lsp,
                contextModeAvailable: ctxMode,
                progress,
                previousOutput: latestResult.output,
                failureReason: latestResult.output,
                parentSessionModel,
              });
              saveAgentResult(platform.paths, ctx.cwd, manifest.id, fixResult);
              latestResult = fixResult;
              if (fixResult.status !== "blocked") {
                fixed = true;
                break;
              }
            }
            // If still blocked after all retries, add to failed set for cascade
            if (!fixed) {
              failedTaskIds.add(failed.taskId);
            }
          } else {
            // No retries configured, mark as failed for cascade
            failedTaskIds.add(failed.taskId);
          }
        }

        const allResults = loadAllAgentResults(platform.paths, ctx.cwd, manifest.id);
        const summary = summarizeBatch(batch, allResults);

        batch.status = summary.allPassed ? "completed" : "failed";
        updateRun(platform.paths, ctx.cwd, manifest);

        if (!summary.allPassed) {
          notifyWarning(
            ctx,
            `Batch ${batch.index + 1} had issues`,
            `${summary.blocked} blocked, ${summary.doneWithConcerns} with concerns`
          );
        }
      }

      const allResults = loadAllAgentResults(platform.paths, ctx.cwd, manifest.id);
      const runSummary = buildRunSummary(allResults);

      if (progress.aborted) {
        manifest.status = "interrupted";
        manifest.completedAt = new Date().toISOString();
        updateRun(platform.paths, ctx.cwd, manifest);
        const durationSec = Math.round(runSummary.totalDuration / 1000);
        notifySummary(
          ctx,
          "Run interrupted",
          `${runSummary.done + runSummary.doneWithConcerns}/${runSummary.totalTasks} tasks completed ` +
          `before interruption | ${durationSec}s — resume with /supi:run`
        );
      } else {
        manifest.status = runSummary.blocked > 0 ? "failed" : "completed";
        manifest.completedAt = new Date().toISOString();
        updateRun(platform.paths, ctx.cwd, manifest);

        const durationSec = Math.round(runSummary.totalDuration / 1000);
        notifySummary(
          ctx,
          "Run complete",
          `${runSummary.done + runSummary.doneWithConcerns}/${runSummary.totalTasks} tasks done ` +
          `(${runSummary.done} clean, ${runSummary.doneWithConcerns} with concerns, ` +
          `${runSummary.blocked} blocked) | ${runSummary.totalFilesChanged} files | ${durationSec}s`
        );
      }

      // Offer branch finish options if we created a worktree branch
      if (branchName && manifest.status === "completed") {
        const finishInstructions = buildBranchFinishPrompt({
          branchName,
          baseBranch: await detectBaseBranch((cmd, args) => platform.exec(cmd, args)),
        });
        platform.sendMessage(
          {
            customType: "supi-branch-finish",
            content: [{ type: "text", text: finishInstructions }],
            display: "none",
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        notifyInfo(ctx, "Run succeeded", "Follow branch finish instructions to integrate your work");
      }
      } finally {
        activeRuns.delete(manifest.id);
        ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
      }
    },
  });
}
