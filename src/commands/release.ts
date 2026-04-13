import type { Platform } from "../platform/types.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import type { ReleaseChannel, BumpType, ReviewReport, ResolvedModel } from "../types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { detectChannels } from "../release/detector.js";
import { parseConventionalCommits, buildChangelogMarkdown, summarizeChanges } from "../release/changelog.js";
import { getCurrentVersion, suggestBump, bumpVersion, isVersionReleased, isTagOnRemote } from "../release/version.js";
import { executeRelease, type ReleaseProgressFn } from "../release/executor.js";
import { buildPolishPrompt } from "../release/prompt.js";
import { notifyInfo, notifySuccess, notifyError } from "../notifications/renderer.js";
import { analyzeAndCommit } from "../git/commit.js";
import { getWorkingTreeStatus } from "../git/status.js";
import { runStructuredAgentSession } from "../quality/ai-session.js";
import {
  loadState as loadDocDriftState,
  readTrackedDocs,
  checkDocDrift,
  DOC_FIX_PROMPT_PREFIX,
} from "../docs/drift.js";
import { runQualityGates } from "../quality/runner.js";
import { REVIEW_GATE_REGISTRY } from "../quality/review-gates.js";
import { GATE_DISPLAY_NAMES } from "../quality/registry.js";
import { createWorkflowProgress } from "../platform/progress.js";

modelRegistry.register({
  id: "release",
  category: "command",
  label: "Release",
  harnessRoleHint: "slow",
});

const BUMP_OPTIONS = [
  "patch — bug fixes only",
  "minor — new features, backwards compatible",
  "major — breaking changes",
];

/**
 * Returns true when re-running supi:release should skip the confirmation
 * dialog and proceed directly to execution.
 *
 * This is the resume path: the version in package.json hasn't been tagged yet
 * AND all channels are already configured — the user staged the release
 * deliberately when they bumped the version, so no new decisions are needed.
 * Dry-run is excluded because it is exploratory by intent.
 */
export function isInProgressRelease(opts: {
  skipBump: boolean;
  channelsWerePreConfigured: boolean;
  isDryRun: boolean;
}): boolean {
  return opts.skipBump && opts.channelsWerePreConfigured && !opts.isDryRun;
}

const RELEASE_STEPS = [
  { key: "working-tree", label: "Check working tree" },
  { key: "doc-drift", label: "Check documentation drift" },
  { key: "checks", label: "Quality checks" },
  { key: "channels", label: "Detect channels" },
  { key: "commits", label: "Analyze commits" },
  { key: "version", label: "Select version" },
  { key: "changelog", label: "Build changelog" },
  { key: "polish", label: "Polish release notes" },
  { key: "execute", label: "Execute release" },
  { key: "publish", label: "Publish channels" },
] as const;

type ReleaseStepKey = (typeof RELEASE_STEPS)[number]["key"];

function createReleaseProgress(ctx: any) {
  const progress = createWorkflowProgress(ctx.ui, {
    title: "supi:release",
    statusKey: "supi-release",
    statusLabel: "Releasing...",
    widgetKey: "supi-release",
    clearStatusKeys: ["supi-model"],
    steps: [...RELEASE_STEPS],
  });

  return {
    activate(key: ReleaseStepKey, detail?: string) {
      progress.activate(key, detail);
    },
    complete(key: ReleaseStepKey, detail?: string) {
      progress.complete(key, detail);
    },
    fail(key: ReleaseStepKey, detail?: string) {
      progress.fail(key, detail);
    },
    skip(key: ReleaseStepKey, detail?: string) {
      progress.skip(key, detail);
    },
    detail(text: string) {
      progress.detail(text);
    },
    /** Build an onProgress callback for executeRelease. */
    executorProgress(): ReleaseProgressFn {
      return (step, status, detail) => {
        const isPublish = step.startsWith("publish-");
        const key: ReleaseStepKey = isPublish ? "publish" : "execute";
        if (status === "active") this.activate(key, detail);
        else if (status === "done") {
          progress.detail(detail ?? "");
        } else if (status === "error") this.fail(key, detail);
      };
    },
    dispose() {
      progress.dispose();
    },
  };
}

/**
 * Register the command for autocomplete and /help listing.
 * Actual execution goes through handleRelease via the TUI dispatch.
 */
export function registerReleaseCommand(platform: Platform): void {
  platform.registerCommand("supi:release", {
    description: "Release automation — version bump, changelog, publish",
    async handler() {
      // No-op: execution is handled by the TUI input interceptor.
      // This registration exists only for autocomplete and /help.
    },
  });
}

/**
 * TUI-only handler — called from the input event dispatcher in bootstrap.ts.
 * Runs the full release flow without triggering the outer LLM session.
 */
export async function handleRelease(platform: Platform, ctx: any, args?: string): Promise<void> {
  const modelCfg = loadModelConfig(platform.paths, ctx.cwd);
  const bridge = createModelBridge(platform);
  const resolved = resolveModelForAction("release", modelRegistry, modelCfg, bridge);
  const modelCleanup = await applyModelOverride(platform, ctx, "release", resolved);

  if (!ctx.hasUI) {
    ctx.ui.notify("Release requires interactive mode", "warning");
    return;
  }

  const progress = createReleaseProgress(ctx);

  void (async () => {
    try {
      const skipPolish = args?.includes("--raw") ?? false;
      const isDryRun = args?.includes("--dry-run") ?? false;
      const config = loadConfig(platform.paths, ctx.cwd);

      // ── 1. Check for uncommitted changes ────────────────────────────────
      progress.activate("working-tree", "Checking working tree");
      let didStash = false;
      const treeStatus = await getWorkingTreeStatus(platform.exec.bind(platform), ctx.cwd);
      if (treeStatus.dirty) {
        progress.complete("working-tree", `${treeStatus.files.length} files changed`);
        const filePreview = treeStatus.files.slice(0, 8).join(", ");
        const extra = treeStatus.files.length > 8 ? ` (+${treeStatus.files.length - 8} more)` : "";

        const action = await ctx.ui.select(
          `Uncommitted changes detected (${treeStatus.files.length} files)`,
          [
            "commit — commit changes with AI-generated message",
            "stash — stash changes and continue",
            "abort — cancel release",
          ],
          { helpText: `Files: ${filePreview}${extra}` },
        );

        if (!action || action.startsWith("abort")) {
          progress.dispose();
          return;
        }

        if (action.startsWith("commit")) {
          // commit.ts has its own progress widget; dispose ours temporarily
          progress.dispose();
          const commitResult = await analyzeAndCommit(platform, ctx);
          if (!commitResult) {
            notifyError(ctx, "Commit failed or cancelled", "Aborting release.");
            return;
          }
          // Verify tree is now clean
          const afterStatus = await getWorkingTreeStatus(platform.exec.bind(platform), ctx.cwd);
          if (afterStatus.dirty) {
            notifyError(ctx, "Still uncommitted changes", "Not all changes were committed. Aborting release.");
            return;
          }
          // Re-create progress after commit's widget has disposed
          progress.complete("working-tree", "Committed");
        } else if (action.startsWith("stash")) {
          progress.activate("working-tree", "Stashing changes");
          const stashResult = await platform.exec("git", ["stash", "push", "-m", "supi:release auto-stash"], { cwd: ctx.cwd });
          if (stashResult.code !== 0) {
            progress.fail("working-tree", stashResult.stderr || "stash failed");
            progress.dispose();
            notifyError(ctx, "git stash failed", stashResult.stderr || "Non-zero exit");
            return;
          }
          didStash = true;
          progress.complete("working-tree", "Stashed");
        }
      } else {
        progress.complete("working-tree", "Clean");
      }

      // ── 2. Doc-drift pre-check ──────────────────────────────────────────
      progress.activate("doc-drift", "Checking documentation drift");
      const driftResult = await checkDocDrift(platform, ctx.cwd);
      if (driftResult?.drifted) {
        progress.complete("doc-drift", "Drift detected");
        const driftAction = await ctx.ui.select(
          "Documentation drift detected before release",
          [
            "Update docs — fix documentation before continuing",
            "Continue — release without updating docs",
          ],
          { helpText: driftResult.summary },
        );

        if (driftAction?.startsWith("Update docs")) {
          progress.activate("doc-drift", "Fixing documentation");
          notifyInfo(ctx, "Updating documentation", driftResult.summary);
          const state = loadDocDriftState(platform.paths, ctx.cwd);
          const docs = readTrackedDocs(ctx.cwd, state.trackedFiles);
          const fileList = state.trackedFiles.join(", ");
          const fixPrompt = DOC_FIX_PROMPT_PREFIX + fileList + "\n\nDrift summary: " + driftResult.summary
            + "\n\nCurrent file contents:\n" + [...docs.entries()].map(([f, c]) => `### ${f}\n\`\`\`\n${c}\n\`\`\``).join("\n\n");
          const fixResult = await runStructuredAgentSession(
            platform.createAgentSession.bind(platform),
            { cwd: ctx.cwd, prompt: fixPrompt },
          );
          if (fixResult.status === "ok") {
            progress.complete("doc-drift", "Fixed");
            notifySuccess(ctx, "Documentation updated");
          } else {
            progress.fail("doc-drift", fixResult.error ?? "Agent session error");
            notifyError(ctx, "Doc update failed", fixResult.error ?? "Agent session error");
            progress.dispose();
            return;
          }
        } else {
          progress.skip("doc-drift", "Skipped by user");
        }
      } else {
        progress.complete("doc-drift", "No drift");
      }

      // ── 3. Quality checks (headless) ────────────────────────────────────
      progress.activate("checks", "Running quality gates");
      const checksReport = await runHeadlessChecks(platform, ctx, config, resolved);
      if (checksReport) {
        const { summary, overallStatus } = checksReport;
        const detail = `${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked`;
        if (overallStatus === "passed") {
          progress.complete("checks", detail);
        } else {
          progress.fail("checks", detail);
          // Show which gates failed but don't block — let the user decide
          const failedNames = checksReport.gates
            .filter((g) => g.status === "failed" || g.status === "blocked")
            .map((g) => GATE_DISPLAY_NAMES[g.gate] ?? g.gate);
          const continueChoice = await ctx.ui.select(
            `Quality checks ${overallStatus}: ${failedNames.join(", ")}`,
            [
              "Continue — release despite failures",
              "Abort — fix issues first",
            ],
            { helpText: detail },
          );
          if (!continueChoice || continueChoice.startsWith("Abort")) {
            progress.dispose();
            return;
          }
        }
      } else {
        progress.skip("checks", "No gates configured");
      }

      // ── 4. Ensure channels are configured (or detect + ask) ─────────────
      progress.activate("channels", "Detecting channels");
      let channels = config.release.channels;
      // Track whether channels were already set in config before any interactive
      // setup. This distinguishes "user already decided" from "just configured now",
      // which determines whether we can auto-continue without a confirmation prompt.
      const channelsWerePreConfigured = config.release.channels.length > 0;

      if (channels.length === 0) {
        progress.complete("channels", "Awaiting selection");
        channels = await setupChannels(platform, ctx);
        if (channels.length === 0) {
          progress.dispose();
          return;
        }
      }
      progress.complete("channels", channels.join(", "));

      // ── 5. Get last tag + current version + check if bump is needed ─────
      progress.activate("commits", "Parsing git history");
      const lastTag = await getLastTag(platform, ctx.cwd);
      const currentVersion = getCurrentVersion(ctx.cwd);
      const localTagExists = await isVersionReleased(
        platform.exec.bind(platform),
        ctx.cwd,
        currentVersion,
      );
      // Only check remote when local tag exists — avoids a network call when
      // the version was never tagged at all.
      const remoteTagExists = localTagExists
        ? await isTagOnRemote(platform.exec.bind(platform), ctx.cwd, currentVersion)
        : false;

      // ── 6. Parse commits since last tag ─────────────────────────────────
      const sinceArg = lastTag ? `${lastTag}..HEAD` : "HEAD~50..HEAD";
      let gitLogOutput: string;
      try {
        const result = await platform.exec(
          "git",
          ["log", sinceArg, "--oneline"],
          { cwd: ctx.cwd },
        );
        gitLogOutput = result.code === 0 ? result.stdout : "";
      } catch {
        gitLogOutput = "";
      }

      const commits = parseConventionalCommits(gitLogOutput);
      const summary = summarizeChanges(commits);
      const commitCount = commits.features.length + commits.fixes.length + commits.breaking.length + commits.improvements.length + commits.maintenance.length + commits.other.length;
      progress.complete("commits", `${commitCount} commits since ${lastTag ?? "start"}`);

      // ── 7. Version resolution ───────────────────────────────────────────
      //    Three states:
      //    a) No local tag              → version is unreleased, skip bump
      //    b) Local tag, not on remote  → incomplete release, skip bump + skip tag
      //    c) Local + remote tag        → fully released, ask for bump
      let nextVersion: string;
      let skipBump: boolean;
      let skipTag = false;

      if (!localTagExists && currentVersion !== "0.0.0") {
        // (a) No tag at all — version in package.json is unreleased
        nextVersion = currentVersion;
        skipBump = true;
        progress.skip("version", `v${currentVersion} (already set, not yet released)`);
        notifyInfo(ctx, `Using v${currentVersion}`, "Version not yet released — skipping bump");
      } else if (localTagExists && !remoteTagExists) {
        // (b) Tag exists locally but never made it to origin — resume
        nextVersion = currentVersion;
        skipBump = true;
        skipTag = true;
        progress.skip("version", `v${currentVersion} (tag exists locally, not pushed)`);
        notifyInfo(ctx, `Resuming v${currentVersion}`, "Tag exists locally but not on remote — will push");
      } else {
        // (c) Fully released — ask for bump
        progress.activate("version", "Awaiting version selection");
        const suggested = suggestBump(commits);
        const bumpChoice = await ctx.ui.select(
          `Version bump (${summary})`,
          BUMP_OPTIONS,
          { helpText: `Current: ${currentVersion} (released) | Suggested: ${suggested}` },
        );
        if (!bumpChoice) {
          progress.dispose();
          return;
        }

        const bump = bumpChoice.split(" — ")[0] as BumpType;
        nextVersion = bumpVersion(currentVersion, bump);
        skipBump = false;
        progress.complete("version", `${currentVersion} → ${nextVersion} (${bump})`);
      }

      // ── 8. Build changelog ──────────────────────────────────────────────
      progress.activate("changelog", "Generating changelog");
      const rawChangelog = buildChangelogMarkdown(commits, nextVersion);
      progress.complete("changelog", `${commitCount} entries`);

      // ── 9. Polish release notes (default, skip with --raw) ──────────────
      let changelog: string;
      if (skipPolish) {
        progress.skip("polish", "Skipped (--raw)");
        changelog = rawChangelog;
      } else {
        progress.activate("polish", "Polishing release notes");
        const polishPrompt = buildPolishPrompt({ changelog: rawChangelog, version: nextVersion });
        const polishResult = await runStructuredAgentSession(
          platform.createAgentSession.bind(platform),
          { cwd: ctx.cwd, prompt: polishPrompt },
        );
        if (polishResult.status === "ok") {
          changelog = polishResult.finalText;
          progress.complete("polish", "Polished");
        } else {
          // Polish failed — fall back to raw changelog, don't block the release
          changelog = rawChangelog;
          progress.fail("polish", polishResult.error ?? "Agent error — using raw changelog");
          notifyInfo(ctx, "Polish failed — using raw changelog", polishResult.error ?? "");
        }
      }

      // ── 10. Confirm via UI ──────────────────────────────────────────────
      //    Skipped when resuming a staged unreleased release.
      const isResume = isInProgressRelease({ skipBump, channelsWerePreConfigured, isDryRun });

      if (isResume) {
        notifyInfo(
          ctx,
          `Resuming release v${nextVersion}`,
          "Version staged and channels configured — proceeding without confirmation",
        );
      } else {
        const confirmLabel = isDryRun ? `[DRY RUN] Ship v${nextVersion}?` : `Ship v${nextVersion}?`;
        // When skipBump=true, currentVersion === nextVersion — avoid the
        // misleading "0.5.0 → 0.5.0" display.
        const versionLine = skipBump
          ? `v${nextVersion} (staged, not yet released)`
          : `${currentVersion} → ${nextVersion}`;
        const confirmDetail = [
          versionLine,
          `Channels: ${channels.join(", ")}`,
          `Changes: ${summary}`,
          "",
          changelog,
        ].join("\n");

        const confirmed = ctx.ui.confirm
          ? await ctx.ui.confirm(confirmLabel, confirmDetail)
          : (await ctx.ui.select(confirmLabel, ["Yes — publish", "No — abort"])) === "Yes — publish";

        if (!confirmed) {
          progress.dispose();
          notifyInfo(ctx, "Release cancelled", "No changes were made");
          return;
        }
      }

      // ── 11. Execute release ─────────────────────────────────────────────
      progress.activate("execute", "Starting release execution");
      try {
        const result = await executeRelease({
          exec: platform.exec.bind(platform),
          cwd: ctx.cwd,
          version: nextVersion,
          changelog,
          channels,
          dryRun: isDryRun,
          skipBump,
          skipTag,
          onProgress: progress.executorProgress(),
        });

        // Mark execution steps based on result
        if (result.tagCreated && result.pushed) {
          progress.complete("execute", "Tag + push complete");
        } else if (result.error) {
          progress.fail("execute", result.error);
        } else {
          progress.fail("execute", `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"}`);
        }

        // Mark channel publishing
        if (result.channels.length > 0) {
          const allOk = result.channels.every((c) => c.success);
          if (allOk) {
            progress.complete("publish", result.channels.map((c) => c.channel).join(", "));
          } else {
            const failedChannels = result.channels.filter((c) => !c.success);
            progress.fail("publish", failedChannels.map((c) => `${c.channel}: ${c.error ?? "failed"}`).join("; "));
          }
        } else if (result.error) {
          progress.skip("publish", "Skipped (release failed)");
        } else {
          progress.complete("publish", "No channels");
        }

        // Give the user a moment to see the final widget state
        await new Promise((r) => setTimeout(r, 1500));
        progress.dispose();

        // Final notification
        const channelSummary = result.channels
          .map((c) => `${c.channel}: ${c.success ? "✓" : `✗ ${c.error ?? "failed"}`}`)
          .join(", ");

        if (result.pushed || isDryRun) {
          const prefix = isDryRun ? "[DRY RUN] " : "";
          notifySuccess(
            ctx,
            `${prefix}Released v${nextVersion}`,
            `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"} | ${channelSummary}`,
          );
        } else {
          // Include the error detail so the user knows WHY it failed
          const detail = result.error
            ? result.error
            : `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"}`;
          notifyError(ctx, `Release v${nextVersion} failed`, detail);
        }
      } catch (err) {
        progress.fail("execute", err instanceof Error ? err.message : "Unknown error");
        await new Promise((r) => setTimeout(r, 1500));
        progress.dispose();
        notifyError(
          ctx,
          "Release failed",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        if (didStash) {
          const popResult = await platform.exec("git", ["stash", "pop"], { cwd: ctx.cwd });
          if (popResult.code !== 0) {
            notifyError(ctx, "Stash pop failed", "Run 'git stash pop' manually to recover your changes");
          }
        }
      }
    } catch (err) {
      progress.dispose();
      notifyError(ctx, "Release error", err instanceof Error ? err.message : String(err));
    } finally {
      await modelCleanup();
    }
  })();
}

/**
 * Run quality gates headlessly — no UI widget of its own, results reported
 * back to the release progress widget.
 *
 * Returns null when no gates are configured (caller should skip the step).
 */
async function runHeadlessChecks(
  platform: Platform,
  ctx: any,
  config: ReturnType<typeof loadConfig>,
  resolved: ResolvedModel,
): Promise<ReviewReport | null> {
  const enabledGates = Object.entries(config.quality.gates)
    .filter(([, gate]) => gate?.enabled === true);

  if (enabledGates.length === 0) {
    return null;
  }

  return runQualityGates({
    platform,
    cwd: ctx.cwd,
    gates: config.quality.gates,
    filters: {},
    reviewModel: resolved,
    gateRegistry: REVIEW_GATE_REGISTRY,
  });
}

async function getLastTag(platform: Platform, cwd: string): Promise<string | null> {
  try {
    const result = await platform.exec("git", ["describe", "--tags", "--abbrev=0"], { cwd });
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

async function setupChannels(platform: Platform, ctx: any): Promise<ReleaseChannel[]> {
  const detected = await detectChannels(platform.exec.bind(platform), ctx.cwd);
  const available = detected.filter((d) => d.available);

  // Build options — offer "both" when both channels are available
  const options: string[] = [];
  if (available.length === 2) {
    options.push(`both — GitHub + npm (${available.map((d) => d.detail).join(", ")})`);
  }
  for (const d of detected) {
    options.push(`${d.channel} — ${d.available ? d.detail : `unavailable (${d.detail})`}`);
  }
  options.push("skip — configure later");

  const choice = await ctx.ui.select(
    "Release Setup — Select publish channels",
    options,
    { helpText: "Which channels should releases be published to?" },
  );

  if (!choice || choice.startsWith("skip")) return [];

  let channels: ReleaseChannel[];
  if (choice.startsWith("both")) {
    channels = available.map((d) => d.channel);
  } else {
    channels = [choice.split(" — ")[0] as ReleaseChannel];
  }

  // Persist to config
  updateConfig(platform.paths, ctx.cwd, { release: { channels } });
  ctx.ui.notify(`Release channels set to: ${channels.join(", ")}`, "info");

  return channels;
}
