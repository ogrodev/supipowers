import type { Platform } from "../platform/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadFixPrConfig, saveFixPrConfig } from "../fix-pr/config.js";
import { buildFixPrOrchestratorPrompt } from "../fix-pr/prompt-builder.js";
import type { FixPrConfig, CommentReplyPolicy } from "../fix-pr/types.js";
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
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fix-pr", "scripts");
}

function findSkillPath(skillName: string): string | null {
  const candidates = [
    path.join(process.cwd(), "skills", skillName, "SKILL.md"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "skills", skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function registerFixPrCommand(platform: Platform): void {
  platform.registerCommand("supi:fix-pr", {
    description: "Fix PR review comments with token-optimized agent orchestration",
    async handler(args: string | undefined, ctx: any): Promise<void> {
      // Resolve and apply model override early — before any logic that might fail
      const modelConfig = loadModelConfig(platform.paths, ctx.cwd);
      const bridge = createModelBridge(platform);
      const resolved = resolveModelForAction("fix-pr", modelRegistry, modelConfig, bridge);
      await applyModelOverride(platform, ctx, resolved);

      // ── Step 1: Detect PR ──────────────────────────────────────────
      let prNumber: number | null = null;
      let repo: string | null = null;

      // Try to parse from args
      const argTrimmed = args?.trim().replace("#", "") || "";
      if (/^\d+$/.test(argTrimmed)) {
        prNumber = parseInt(argTrimmed, 10);
      }

      // Detect repo
      try {
        const repoResult = await platform.exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: ctx.cwd });
        if (repoResult.code === 0) repo = repoResult.stdout.trim();
      } catch { /* ignore */ }

      if (!repo) {
        notifyError(ctx, "Could not detect repository", "Run from a git repo with gh CLI configured");
        return;
      }

      // Detect PR number from current branch if not provided
      if (!prNumber) {
        try {
          const prResult = await platform.exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd: ctx.cwd });
          if (prResult.code === 0) prNumber = parseInt(prResult.stdout.trim(), 10);
        } catch { /* ignore */ }
      }

      if (!prNumber) {
        notifyError(ctx, "No PR found", "Provide PR number as argument or run from a PR branch");
        return;
      }

      // ── Step 2: Load or create config ──────────────────────────────
      let config = loadFixPrConfig(platform.paths, ctx.cwd);

      if (!config && ctx.hasUI) {
        config = await runSetupWizard(ctx);
        if (!config) return; // user cancelled
        saveFixPrConfig(platform.paths, ctx.cwd, config);
        ctx.ui.notify(`Fix-PR config saved to ${platform.paths.dotDirDisplay}/supipowers/fix-pr.json`, "info");
      }

      if (!config) {
        notifyError(ctx, "No fix-pr config", "Run interactively first to set up configuration");
        return;
      }

      // ── Step 3: Session handling ───────────────────────────────────
      let activeSession = findActiveFixPrSession(platform.paths, ctx.cwd);

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
        createFixPrSession(platform.paths, ctx.cwd, ledger);
      }

      // ── Step 4: Fetch initial comments ─────────────────────────────
      const sessionDir = getSessionDir(platform.paths, ctx.cwd, ledger.id);
      const scriptsDir = getScriptsDir();
      const snapshotPath = path.join(sessionDir, "snapshots", `comments-${ledger.iteration}.jsonl`);

      const fetchResult = await platform.exec("bash", [
        path.join(scriptsDir, "fetch-pr-comments.sh"),
        repo,
        String(prNumber),
        snapshotPath,
      ], { cwd: ctx.cwd });

      if (fetchResult.code !== 0) {
        notifyError(ctx, "Failed to fetch PR comments", fetchResult.stderr);
        return;
      }

      // Read the snapshot
      let comments = "";
      try {
        comments = fs.readFileSync(snapshotPath, "utf-8").trim();
      } catch {
        notifyWarning(ctx, "No comments found", "PR has no review comments to process");
        return;
      }

      if (!comments) {
        notifyInfo(ctx, "No comments to process", "PR has no review comments");
        return;
      }

      const commentCount = comments.split("\n").length;

      // Auto-detect bot reviewers from comment data
      const detectedBots = detectBotReviewers(comments);
      if (detectedBots.length > 0) {
        config = {
          ...config,
          reviewer: {
            type: detectedBots[0].type,
            triggerMethod: detectedBots[0].triggerMethod,
          },
        };
      }

      // ── Step 5: Load skill ─────────────────────────────────────────
      let skillContent = "";
      const skillPath = findSkillPath("fix-pr");
      if (skillPath) {
        try {
          skillContent = fs.readFileSync(skillPath, "utf-8");
        } catch { /* proceed without */ }
      }

      // ── Step 6: Build and send prompt ──────────────────────────────
      // Resolve task model (sub-agents: planner, fixer). Falls back to fix-pr model.
      const taskResolved = resolveModelForAction("task", modelRegistry, modelConfig, bridge);
      const taskModel = taskResolved.model ?? resolved.model ?? "claude-sonnet-4-6";
      const prompt = buildFixPrOrchestratorPrompt({
        prNumber,
        repo,
        comments,
        sessionDir,
        scriptsDir,
        config,
        iteration: ledger.iteration,
        skillContent,
        taskModel,
      });


      platform.sendMessage(
        {
          customType: "supi-fix-pr",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer", triggerTurn: true },
      );

      notifyInfo(ctx, `Fix-PR started: PR #${prNumber}`, `${commentCount} comments to assess | session ${ledger.id}`);
    },
  });
}

// ── Setup Wizard ───────────────────────────────────────────────────────


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

  // 2. Comment reply policy
  const policyChoice = await ctx.ui.select(
    "Comment reply policy",
    POLICY_OPTIONS,
    { helpText: "How should we handle replying to comments?" },
  );
  if (!policyChoice) return null;

  let commentPolicy: CommentReplyPolicy = "answer-selective";
  if (policyChoice.startsWith("Answer all")) commentPolicy = "answer-all";
  else if (policyChoice.startsWith("Don't")) commentPolicy = "no-answer";

  // 3. Loop timing
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
