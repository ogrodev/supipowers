import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Platform } from "../platform/types.js";
import type { WorkspaceTarget } from "../types.js";
import { buildWorkspaceTargetOptionLabel, parseTargetArg, selectWorkspaceTarget, stripCliArg, tokenizeCliArgs } from "../workspace/selector.js";
import { resolvePackageManager } from "../workspace/package-manager.js";
import { resolveRepoRoot } from "../workspace/repo-root.js";
import { discoverWorkspaceTargets } from "../workspace/targets.js";
import { moduleDir, toBashPath } from "../utils/paths.js";
import { loadFixPrConfig, saveFixPrConfig } from "../fix-pr/config.js";
import { buildFixPrOrchestratorPrompt } from "../fix-pr/prompt-builder.js";
import type { FixPrAssessmentBatch } from "../fix-pr/contracts.js";
import type { FixPrConfig, CommentReplyPolicy, PrComment } from "../fix-pr/types.js";
import {
  clusterPrCommentsByTarget,
  fetchPrComments,
  parsePrCommentsJsonl,
  stringifyPrCommentsJsonl,
} from "../fix-pr/fetch-comments.js";
import {
  generateFixPrSessionId,
  createFixPrSession,
  findActiveFixPrSession,
  getSessionDir,
} from "../storage/fix-pr-sessions.js";
import { notifyInfo, notifyError, notifyWarning } from "../notifications/renderer.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { detectBotReviewers } from "../fix-pr/bot-detector.js";
import { runFixPrAssessment, groupAssessmentsIntoBatches } from "../fix-pr/assessment.js";
import { updateFixPrSession } from "../storage/fix-pr-sessions.js";

modelRegistry.register({
  id: "fix-pr",
  category: "command",
  label: "Fix PR",
  harnessRoleHint: "default",
});

modelRegistry.register({
  id: "task",
  category: "sub-agent",
  parent: "fix-pr",
  label: "Task (sub-agent)",
  harnessRoleHint: "default",
});

function getScriptsDir(): string {
  return toBashPath(path.join(moduleDir(import.meta.url), "..", "fix-pr", "scripts"));
}

function findSkillPath(skillName: string): string | null {
  const candidates = [
    path.join(process.cwd(), "skills", skillName, "SKILL.md"),
    path.join(moduleDir(import.meta.url), "..", "..", "skills", skillName, "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}


function parsePrNumberArg(args?: string): number | null {
  const tokens = tokenizeCliArgs(stripCliArg(args, "--target"));

  for (const token of tokens) {
    const normalized = token.replace(/^#/, "");
    if (/^\d+$/.test(normalized)) {
      return parseInt(normalized, 10);
    }
  }

  return null;
}


function describeTarget(target: WorkspaceTarget): string {
  return target.kind === "root"
    ? `root (${target.relativeDir})`
    : `${target.name} (${target.relativeDir})`;
}

function formatCommentCount(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"}`;
}

function formatUnscopedCommentCount(count: number): string {
  return `${formatCommentCount(count)} without file path`;
}

function buildCommentTargetOptions(
  targets: readonly WorkspaceTarget[],
  commentsByTargetId: ReadonlyMap<string, readonly PrComment[]>,
) {
  return targets.flatMap((target) => {
    const count = commentsByTargetId.get(target.id)?.length ?? 0;
    if (count === 0) {
      return [];
    }

    return [{
      target,
      changed: true,
      label: buildWorkspaceTargetOptionLabel({ target, changed: true }, [formatCommentCount(count)]),
    }];
  });
}

function countUnresolvedAssessments(assessment: FixPrAssessmentBatch): number {
  return assessment.assessments.filter((item: FixPrAssessmentBatch["assessments"][number]) => item.verdict !== "apply").length;
}


function buildDeferredCommentsSummary(
  options: ReadonlyArray<{ target: WorkspaceTarget }>,
  commentsByTargetId: ReadonlyMap<string, readonly PrComment[]>,
  selectedTarget: WorkspaceTarget,
  unscopedCommentCount: number,
 ): string | null {
  const deferred = options
    .filter((option) => option.target.id !== selectedTarget.id)
    .map((option) => `${describeTarget(option.target)}: ${formatCommentCount(commentsByTargetId.get(option.target.id)?.length ?? 0)}`);

  if (unscopedCommentCount > 0) {
    deferred.push(`unscoped review comments: ${formatUnscopedCommentCount(unscopedCommentCount)}`);
  }

  return deferred.length > 0 ? deferred.join("; ") : null;
}

function buildAvailableTargetDetail(
  options: ReadonlyArray<{ target: WorkspaceTarget }>,
  unscopedCommentCount: number,
 ): string {
  const availableTargets = options.length > 0
    ? `Available targets: ${options.map((option) => option.target.id).join(", ")}`
    : "No package or root targets have actionable comments in this PR snapshot.";

  if (unscopedCommentCount === 0) {
    return availableTargets;
  }

  return `${availableTargets} Deferred unscoped review comments: ${formatUnscopedCommentCount(unscopedCommentCount)}.`;
}

export function registerFixPrCommand(platform: Platform): void {
  platform.registerCommand("supi:fix-pr", {
    description: "Fix PR review comments with token-optimized agent orchestration",
    async handler(args: string | undefined, ctx: any): Promise<void> {
      const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
      const bridge = createModelBridge(platform);
      const resolved = resolveModelForAction("fix-pr", modelRegistry, modelConfig, bridge);
      await applyModelOverride(platform, ctx, "fix-pr", resolved);

      let prNumber = parsePrNumberArg(args);
      let repo: string | null = null;
      const requestedTarget = parseTargetArg(args);

      try {
        const repoResult = await platform.exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: ctx.cwd });
        if (repoResult.code === 0) repo = repoResult.stdout.trim();
      } catch {
        // ignore
      }

      if (!repo) {
        notifyError(ctx, "Could not detect repository", "Run from a git repo with gh CLI configured");
        return;
      }

      if (!prNumber) {
        try {
          const prResult = await platform.exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd: ctx.cwd });
          if (prResult.code === 0) prNumber = parseInt(prResult.stdout.trim(), 10);
        } catch {
          // ignore
        }
      }

      if (!prNumber) {
        notifyError(ctx, "No PR found", "Provide PR number as argument or run from a PR branch");
        return;
      }

      const repoRoot = await resolveRepoRoot(platform, ctx.cwd);
      if (!repoRoot) {
        notifyError(ctx, "Could not detect repository root", "Run from inside a git worktree");
        return;
      }

      const packageManager = resolvePackageManager(repoRoot);
      const workspaceTargets = discoverWorkspaceTargets(repoRoot, packageManager.id);
      if (workspaceTargets.length === 0) {
        notifyError(ctx, "No workspace targets found", `Could not discover package targets from ${repoRoot}`);
        return;
      }

      let config = loadFixPrConfig(platform.paths, ctx.cwd);
      if (!config && ctx.hasUI) {
        config = await runSetupWizard(ctx);
        if (!config) return;
        saveFixPrConfig(platform.paths, ctx.cwd, config);
        ctx.ui.notify(`Fix-PR config saved to ${platform.paths.dotDirDisplay}/supipowers/fix-pr.json`, "info");
      }

      if (!config) {
        notifyError(ctx, "No fix-pr config", "Run interactively first to set up configuration");
        return;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-fix-pr-"));
      try {
        const fetchedCommentsPath = path.join(tempDir, "comments.jsonl");
        const fetchError = await fetchPrComments(platform, repo, prNumber, fetchedCommentsPath, repoRoot);
        if (fetchError) {
          notifyError(ctx, "Failed to fetch PR comments", fetchError);
          return;
        }

        const fetchedComments = fs.readFileSync(fetchedCommentsPath, "utf-8").trim();
        if (!fetchedComments) {
          notifyInfo(ctx, "No comments to process", "PR has no review comments");
          return;
        }

        const parsedComments = parsePrCommentsJsonl(fetchedComments);
        if (parsedComments.length === 0) {
          notifyWarning(ctx, "No comments found", "PR comments could not be parsed from the fetched snapshot");
          return;
        }

        const clusteredComments = clusterPrCommentsByTarget(workspaceTargets, parsedComments);
        const targetOptions = buildCommentTargetOptions(
          workspaceTargets,
          clusteredComments.commentsByTargetId,
        );

        if (targetOptions.length === 0) {
          const detail = clusteredComments.unscopedComments.length > 0
            ? `PR comments were fetched but only ${formatUnscopedCommentCount(clusteredComments.unscopedComments.length)} could not be assigned to a workspace target`
            : "PR comments were fetched but could not be assigned to a package or root target";
          notifyWarning(ctx, "No actionable comments found", detail);
          return;
        }

        if (!requestedTarget && !ctx.hasUI && targetOptions.length > 1) {
          notifyError(ctx, "Multiple comment targets found", buildAvailableTargetDetail(targetOptions, clusteredComments.unscopedComments.length));
          return;
        }

        const selectedTarget = await selectWorkspaceTarget(ctx, targetOptions, requestedTarget, {
          title: "Fix-PR target",
          helpText: "Select one target to process for this run",
        });
        if (!selectedTarget) {
          if (requestedTarget) {
            notifyError(ctx, "Target has no review comments", buildAvailableTargetDetail(targetOptions, clusteredComments.unscopedComments.length));
          }
          return;
        }

        const selectedComments = clusteredComments.commentsByTargetId.get(selectedTarget.id) ?? [];
        if (selectedComments.length === 0) {
          notifyInfo(ctx, "No comments for selected target", `${selectedTarget.id} has no actionable comments in this PR snapshot`);
          return;
        }

        let activeSession = findActiveFixPrSession(platform.paths, selectedTarget, repo, prNumber);
        if (activeSession && ctx.hasUI) {
          const choice = await ctx.ui.select(
            "Fix-PR Session",
            [
              `Resume ${activeSession.id} (iteration ${activeSession.iteration}, PR #${activeSession.prNumber})`,
              "Start new session",
            ],
            { helpText: "Select session · Esc to cancel" },
          );
          if (!choice) return;
          if (choice.startsWith("Start new")) activeSession = null;
        }

        const ledger = activeSession ?? {
          id: generateFixPrSessionId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          prNumber,
          repo,
          status: "running" as const,
          iteration: 0,
          config,
          commentsProcessed: [],
        };

        if (!activeSession) {
          createFixPrSession(platform.paths, selectedTarget, ledger);
        }

        const sessionDir = toBashPath(getSessionDir(platform.paths, selectedTarget, ledger.id));
        const scriptsDir = getScriptsDir();
        const snapshotPath = path.join(sessionDir, "snapshots", `comments-${ledger.iteration}.jsonl`);
        const selectedCommentsJsonl = stringifyPrCommentsJsonl(selectedComments);
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, selectedCommentsJsonl);

        const detectedBots = detectBotReviewers(selectedCommentsJsonl);
        if (detectedBots.length > 0) {
          config = {
            ...config,
            reviewer: {
              type: detectedBots[0].type,
              triggerMethod: detectedBots[0].triggerMethod,
            },
          };
        }

        let skillContent = "";
        const skillPath = findSkillPath("fix-pr");
        if (skillPath) {
          try {
            skillContent = fs.readFileSync(skillPath, "utf-8");
          } catch {
            // proceed without skill content
          }
        }

        const taskResolved = resolveModelForAction("task", modelRegistry, modelConfig, bridge);
        const taskModel = taskResolved.model ?? resolved.model ?? "claude-sonnet-4-6";
        const deferredCommentsSummary = buildDeferredCommentsSummary(
          targetOptions,
          clusteredComments.commentsByTargetId,
          selectedTarget,
          clusteredComments.unscopedComments.length,
        );

        const assessmentResult = await runFixPrAssessment({
          createAgentSession: platform.createAgentSession,
          paths: platform.paths,
          cwd: ctx.cwd,
          comments: selectedComments,
          repo,
          prNumber,
          selectedTargetLabel: describeTarget(selectedTarget),
          model: resolved.model,
          thinkingLevel: resolved.thinkingLevel,
        });
        if (assessmentResult.status === "blocked") {
          notifyError(ctx, "Fix-PR assessment failed", assessmentResult.error);
          return;
        }
        const assessment = assessmentResult.output;
        const unresolvedAssessmentCount = countUnresolvedAssessments(assessment);
        const workBatches = groupAssessmentsIntoBatches(assessment);
        ledger.assessment = assessment;
        updateFixPrSession(platform.paths, selectedTarget, ledger);

        if (unresolvedAssessmentCount > 0) {
          notifyWarning(
            ctx,
            "Unresolved comments remain",
            `${formatCommentCount(unresolvedAssessmentCount)} for ${describeTarget(selectedTarget)} still need rejection or investigation handling before this run can be considered complete.`,
          );
        }

        const prompt = buildFixPrOrchestratorPrompt({
          prNumber,
          repo,
          comments: selectedCommentsJsonl.trim(),
          sessionDir,
          scriptsDir,
          config,
          iteration: ledger.iteration,
          skillContent,
          taskModel,
          selectedTargetLabel: describeTarget(selectedTarget),
          deferredCommentsSummary,
          assessment,
          workBatches,
        });

        platform.sendMessage(
          {
            customType: "supi-fix-pr",
            content: [{ type: "text", text: prompt }],
            display: "none",
          },
          { deliverAs: "steer", triggerTurn: true },
        );

        const detailParts = [`${formatCommentCount(selectedComments.length)} for ${describeTarget(selectedTarget)}`];
        if (deferredCommentsSummary) {
          detailParts.push(`deferred: ${deferredCommentsSummary}`);
        }
        notifyInfo(ctx, `Fix-PR started: PR #${prNumber}`, `${detailParts.join(" | ")} | session ${ledger.id}`);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  });
}

const POLICY_OPTIONS = [
  "Answer all comments",
  "Only answer wrong/unnecessary ones (recommended)",
  "Don't answer, just fix",
];

const DELAY_OPTIONS = [
  "60 seconds",
  "120 seconds",
  "180 seconds (recommended)",
  "300 seconds",
];

const ITERATION_OPTIONS = [
  "1",
  "2",
  "3 (recommended)",
  "5",
];

async function runSetupWizard(ctx: any): Promise<FixPrConfig | null> {
  const policyChoice = await ctx.ui.select(
    "Comment reply policy",
    POLICY_OPTIONS,
    { helpText: "How should we handle replying to comments?" },
  );
  if (!policyChoice) return null;

  let commentPolicy: CommentReplyPolicy = "answer-selective";
  if (policyChoice.startsWith("Answer all")) commentPolicy = "answer-all";
  else if (policyChoice.startsWith("Don't")) commentPolicy = "no-answer";

  const delayChoice = await ctx.ui.select(
    "Delay between review checks",
    DELAY_OPTIONS,
    { helpText: "How long to wait for reviewer after pushing changes" },
  );
  if (!delayChoice) return null;
  const delaySeconds = parseInt(delayChoice, 10);

  const iterChoice = await ctx.ui.select(
    "Max review iterations",
    ITERATION_OPTIONS,
    { helpText: "Maximum fix-check-fix cycles" },
  );
  if (!iterChoice) return null;
  const maxIterations = parseInt(iterChoice, 10);

  const config: FixPrConfig = {
    reviewer: { type: "none", triggerMethod: null },
    commentPolicy,
    loop: { delaySeconds, maxIterations },
  };

  return config;
}
