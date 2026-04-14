import type { Platform } from "../platform/types.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { resolveModelForAction, createModelBridge, applyModelOverride } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import type { ReleaseChannel, BumpType, ReviewReport, ResolvedModel } from "../types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { detectChannels } from "../release/detector.js";
import type { ChannelStatus } from "../release/channels/types.js";
import { parseConventionalCommits, buildChangelogMarkdown, summarizeChanges } from "../release/changelog.js";
import {
  getCurrentVersion,
  suggestBump,
  bumpVersion,
  isVersionReleased,
  isTagOnRemote,
  findResumableLocalRelease,
  formatTag,
} from "../release/version.js";
import { executeRelease, type ReleaseProgressFn } from "../release/executor.js";
import { buildPolishPrompt } from "../release/prompt.js";
import { notifyInfo, notifySuccess, notifyError } from "../notifications/renderer.js";
import { analyzeAndCommit } from "../git/commit.js";
import { getWorkingTreeStatus } from "../git/status.js";
import { runStructuredAgentSession } from "../quality/ai-session.js";
import {
  checkDocDrift,
  buildFixPrompt,
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

export function findInvalidReleaseChannels(
  channels: ReleaseChannel[],
  detected: ChannelStatus[],
): string[] {
  const detectedById = new Map(detected.map((status) => [status.channel, status]));

  return channels.flatMap((channel) => {
    const status = detectedById.get(channel);
    if (!status) {
      return [`${channel}: unknown channel`];
    }
    if (!status.available) {
      return [`${channel}: unavailable (${status.detail})`];
    }
    return [];
  });
}

export function buildSelectableReleaseChannelOptions(detected: ChannelStatus[]): string[] {
  return detected
    .filter((channel) => channel.available)
    .map((channel) => `${channel.channel} — ${channel.detail}`);
}

interface GitHubAuthAccount {
  host: string;
  user: string;
  active: boolean;
}

export function isGitHubPermissionDeniedError(detail: string | undefined): boolean {
  if (!detail) {
    return false;
  }

  const normalized = detail.toLowerCase();
  return normalized.includes("github.com")
    && normalized.includes("403")
    && (normalized.includes("permission to") || normalized.includes("denied to"));
}

export function parseGithubAuthStatusAccounts(output: string, host = "github.com"): GitHubAuthAccount[] {
  const accounts: GitHubAuthAccount[] = [];
  let currentAccount: GitHubAuthAccount | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const accountMatch = line.match(/^✓ Logged in to (\S+) account ([^(]+?) \(/);
    if (accountMatch) {
      currentAccount = {
        host: accountMatch[1] ?? "",
        user: (accountMatch[2] ?? "").trim(),
        active: false,
      };
      if (currentAccount.host === host) {
        accounts.push(currentAccount);
      } else {
        currentAccount = null;
      }
      continue;
    }

    if (currentAccount && line.startsWith("- Active account:")) {
      currentAccount.active = line.endsWith("true");
    }
  }

  return accounts;
}

export async function maybeSwitchGithubAccountForReleaseFailure(
  platform: Pick<Platform, "exec">,
  ctx: { cwd: string; ui: { select: (title: string, options: string[], opts?: { helpText?: string }) => Promise<string | null>; notify?: (message: string, type?: string) => void } },
  detail: string | undefined,
): Promise<string | null> {
  if (!isGitHubPermissionDeniedError(detail)) {
    return null;
  }

  const statusResult = await platform.exec("gh", ["auth", "status", "--hostname", "github.com"], { cwd: ctx.cwd });
  if (statusResult.code !== 0) {
    return null;
  }

  const accounts = parseGithubAuthStatusAccounts(`${statusResult.stdout}\n${statusResult.stderr}`);
  if (accounts.length < 2) {
    return null;
  }

  const deniedUser = detail?.match(/denied to\s+([A-Za-z0-9-]+)/i)?.[1] ?? null;
  const options = accounts.map((account) => {
    const suffix: string[] = [];
    if (account.active) suffix.push("current");
    if (deniedUser && account.user === deniedUser) suffix.push("denied here");
    return suffix.length > 0 ? `${account.user} — ${suffix.join(", ")}` : account.user;
  });

  const choice = await ctx.ui.select(
    "GitHub account mismatch detected",
    options,
    {
      helpText: deniedUser
        ? `GitHub denied the current release with account ${deniedUser}. Choose another authenticated GitHub account to retry the release.`
        : "GitHub denied the current release. Choose another authenticated GitHub account to retry.",
    },
  );
  if (!choice) {
    return null;
  }

  const selectedUser = choice.split(" — ")[0] ?? choice;
  const switchResult = await platform.exec(
    "gh",
    ["auth", "switch", "--hostname", "github.com", "--user", selectedUser],
    { cwd: ctx.cwd },
  );
  if (switchResult.code !== 0) {
    ctx.ui.notify?.(`GitHub account switch failed: ${switchResult.stderr || switchResult.stdout || "unknown error"}`, "error");
    return null;
  }

  return selectedUser;
}


export const RELEASE_STEPS = [
  { key: "checks", label: "Quality checks" },
  { key: "doc-drift", label: "Check documentation drift" },
  { key: "working-tree", label: "Check working tree" },
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
      const tagFormat = config.release.tagFormat;
      let didStash = false;

      // ── 1. Quality checks (headless) ────────────────────────────────────
      progress.activate("checks", "Running quality gates");
      const checksReport = await runHeadlessChecks(platform, ctx, config, resolved);
      if (checksReport) {
        const { summary, overallStatus } = checksReport;
        const detail = `${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked`;
        if (overallStatus === "passed") {
          progress.complete("checks", detail);
        } else {
          progress.fail("checks", detail);
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
          const fixPrompt = buildFixPrompt(driftResult.findings);
          const { loadState: loadDriftState, saveState: saveDriftState, getHeadCommit } = await import("../docs/drift.js");
          const driftHead = await getHeadCommit(platform, ctx.cwd);
          const driftState = loadDriftState(platform.paths, ctx.cwd);
          saveDriftState(platform.paths, ctx.cwd, { ...driftState, lastCommit: driftHead, lastRunAt: new Date().toISOString() });

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

      // ── 3. Check for uncommitted changes after preflight side effects ─────
      progress.activate("working-tree", "Checking working tree");
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
          progress.dispose();
          const commitResult = await analyzeAndCommit(platform, ctx);
          if (!commitResult) {
            notifyError(ctx, "Commit failed or cancelled", "Aborting release.");
            return;
          }
          const afterStatus = await getWorkingTreeStatus(platform.exec.bind(platform), ctx.cwd);
          if (afterStatus.dirty) {
            notifyError(ctx, "Still uncommitted changes", "Not all changes were committed. Aborting release.");
            return;
          }
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

      // ── 4. Ensure channels are configured (or detect + ask) ─────────────
      progress.activate("channels", "Detecting channels");
      const customChannels = config.release.customChannels ?? {};
      const detectedChannels = await detectChannels(platform.exec.bind(platform), ctx.cwd, customChannels);
      let channels = config.release.channels;
      // Track whether channels were already set in config before any interactive
      // setup. This distinguishes "user already decided" from "just configured now",
      // which determines whether we can auto-continue without a confirmation prompt.
      const channelsWerePreConfigured = config.release.channels.length > 0;

      if (channelsWerePreConfigured) {
        const invalidChannels = findInvalidReleaseChannels(channels, detectedChannels);
        if (invalidChannels.length > 0) {
          const detail = invalidChannels.join("; ");
          progress.fail("channels", detail);
          notifyError(ctx, "Release channels invalid", detail);
          progress.dispose();
          return;
        }
      }

      if (channels.length === 0) {
        progress.complete("channels", "Awaiting selection");
        channels = await setupChannels(platform, ctx, detectedChannels);
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
      const resumableLocalRelease = await findResumableLocalRelease(
        platform.exec.bind(platform),
        ctx.cwd,
        currentVersion,
        tagFormat,
      );
      const localTagExists = await isVersionReleased(
        platform.exec.bind(platform),
        ctx.cwd,
        currentVersion,
        tagFormat,
      );
      const remoteTagExists = localTagExists
        ? await isTagOnRemote(platform.exec.bind(platform), ctx.cwd, currentVersion, tagFormat)
        : false;

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

      let nextVersion: string | null = null;
      let skipBump: boolean | null = null;
      let skipTag = false;

      if (resumableLocalRelease) {
        progress.activate("version", "Found local release tag");
        const resumeChoice = await ctx.ui.select(
          `Continue failed release ${resumableLocalRelease.tag}?`,
          [
            `Continue — resume ${resumableLocalRelease.tag}`,
            "Ignore — choose version normally",
          ],
          {
            helpText: [
              `A newer local tag (${resumableLocalRelease.tag}) exists on the current HEAD but is not on origin.`,
              `package.json still reports ${currentVersion}.`,
              "No commits or worktree changes were detected after that local tag.",
            ].join(" "),
          },
        );
        if (!resumeChoice) {
          progress.dispose();
          return;
        }

        if (resumeChoice.startsWith("Continue")) {
          nextVersion = resumableLocalRelease.version;
          skipBump = true;
          skipTag = true;
          progress.skip("version", `${resumableLocalRelease.tag} (local tag not deployed)`);
          notifyInfo(
            ctx,
            `Resuming failed release ${resumableLocalRelease.tag}`,
            "Local tag exists only on this machine — release will continue from that tagged commit.",
          );
        }
      }

      if (nextVersion === null || skipBump === null) {
        if (!localTagExists && currentVersion !== "0.0.0") {
          nextVersion = currentVersion;
          skipBump = true;
          progress.skip("version", `${formatTag(currentVersion, tagFormat)} (already set, not yet released)`);
          notifyInfo(ctx, `Using ${formatTag(currentVersion, tagFormat)}`, "Version not yet released — skipping bump");
        } else if (localTagExists && !remoteTagExists) {
          nextVersion = currentVersion;
          skipBump = true;
          skipTag = true;
          progress.skip("version", `${formatTag(currentVersion, tagFormat)} (tag exists locally, not pushed)`);
          notifyInfo(ctx, `Resuming ${formatTag(currentVersion, tagFormat)}`, "Tag exists locally but not on remote — will push");
        } else {
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
      }
      // ── 8. Build changelog ──────────────────────────────────────────────
      progress.activate("changelog", "Generating changelog");
      const rawChangelog = buildChangelogMarkdown(commits, nextVersion, tagFormat);
      progress.complete("changelog", `${commitCount} entries`);

      // ── 9. Polish release notes (default, skip with --raw) ──────────────
      let changelog: string;
      if (skipPolish) {
        progress.skip("polish", "Skipped (--raw)");
        changelog = rawChangelog;
      } else {
        progress.activate("polish", "Polishing release notes");
        const polishPrompt = buildPolishPrompt({ changelog: rawChangelog, version: nextVersion, tagFormat });
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
          `Resuming release ${formatTag(nextVersion, tagFormat)}`,
          "Version staged and channels configured — proceeding without confirmation",
        );
      } else {
        const confirmLabel = isDryRun ? `[DRY RUN] Ship ${formatTag(nextVersion, tagFormat)}?` : `Ship ${formatTag(nextVersion, tagFormat)}?`;
        // When skipBump=true, currentVersion === nextVersion — avoid the
        // misleading "0.5.0 → 0.5.0" display.
        const versionLine = skipBump
          ? `${formatTag(nextVersion, tagFormat)} (staged, not yet released)`
          : `${currentVersion} \u2192 ${nextVersion}`;
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
        let result = await executeRelease({
          exec: platform.exec.bind(platform),
          cwd: ctx.cwd,
          version: nextVersion,
          changelog,
          channels,
          dryRun: isDryRun,
          skipBump,
          skipTag,
          tagFormat,
          customChannels,
          onProgress: progress.executorProgress(),
        });

        if (!isDryRun && result.error && !result.pushed) {
          const switchedTo = await maybeSwitchGithubAccountForReleaseFailure(platform, ctx, result.error);
          if (switchedTo) {
            progress.activate("execute", `Retrying with GitHub account ${switchedTo}`);
            result = await executeRelease({
              exec: platform.exec.bind(platform),
              cwd: ctx.cwd,
              version: nextVersion,
              changelog,
              channels,
              dryRun: false,
              skipBump: true,
              skipTag: true,
              tagFormat,
              customChannels,
              onProgress: progress.executorProgress(),
            });
          }
        }

        if (result.tagCreated && result.pushed) {
          progress.complete("execute", "Tag + push complete");
        } else if (result.error) {
          progress.fail("execute", result.error);
        } else {
          progress.fail("execute", `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"}`);
        }

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

        await new Promise((r) => setTimeout(r, 1500));
        progress.dispose();

        const channelSummary = result.channels
          .map((c) => `${c.channel}: ${c.success ? "✓" : `✗ ${c.error ?? "failed"}`}`)
          .join(", ");

        if (result.pushed || isDryRun) {
          const prefix = isDryRun ? "[DRY RUN] " : "";
          notifySuccess(
            ctx,
            `${prefix}Released ${formatTag(nextVersion, tagFormat)}`,
            `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"} | ${channelSummary}`,
          );
        } else {
          const detail = result.error
            ? result.error
            : `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"}`;
          notifyError(ctx, `Release ${formatTag(nextVersion, tagFormat)} failed`, detail);
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

async function setupChannels(
  platform: Platform,
  ctx: any,
  detected: ChannelStatus[],
): Promise<ReleaseChannel[]> {
  const availableChannels = detected.filter((channel) => channel.available);
  const unavailableChannels = detected.filter((channel) => !channel.available);
  const unavailableSummary = unavailableChannels
    .map((channel) => `${channel.channel}: ${channel.detail}`)
    .join("; ");

  if (availableChannels.length === 0) {
    const detail = unavailableSummary || "No release channels are currently available.";
    ctx.ui.notify(`No release channels are currently available. ${detail}`, "warning");
    return [];
  }

  const channelOptions = buildSelectableReleaseChannelOptions(detected);
  const helpText = unavailableSummary
    ? `Select channels one at a time. Pick Done when finished. Unavailable: ${unavailableSummary}`
    : "Select channels one at a time. Pick Done when finished.";

  // Loop-based multi-select: user picks channels one at a time, "Done" to finish
  const selected: ReleaseChannel[] = [];

  while (true) {
    const remaining = channelOptions.filter(
      (option) => !selected.includes(option.split(" — ")[0]),
    );
    const options = [
      ...remaining,
      ...(selected.length > 0 ? [`Done — selected: ${selected.join(", ")}`] : []),
      "skip — configure later",
    ];

    const choice = await ctx.ui.select(
      selected.length === 0
        ? "Release Setup — Select publish channels"
        : `Selected: ${selected.join(", ")} — add more or Done`,
      options,
      { helpText },
    );

    if (!choice || choice.startsWith("skip")) {
      if (selected.length > 0) break; // keep what was selected
      return [];
    }
    if (choice.startsWith("Done")) break;

    const channelId = choice.split(" — ")[0];
    if (!selected.includes(channelId)) {
      selected.push(channelId);
    }
  }

  // Persist to config
  updateConfig(platform.paths, ctx.cwd, { release: { channels: selected } });
  ctx.ui.notify(`Release channels set to: ${selected.join(", ")}`, "info");

  return selected;
}
