import type { Platform } from "../platform/types.js";
import type { ReleaseChannel, BumpType } from "../types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { detectChannels } from "../release/detector.js";
import { parseConventionalCommits, buildChangelogMarkdown, summarizeChanges } from "../release/changelog.js";
import { getCurrentVersion, suggestBump, bumpVersion } from "../release/version.js";
import { executeRelease, type ReleaseProgressFn } from "../release/executor.js";
import { buildPolishPrompt } from "../release/prompt.js";
import { notifyInfo, notifySuccess, notifyError } from "../notifications/renderer.js";
import { analyzeAndCommit } from "../git/commit.js";
import { getWorkingTreeStatus } from "../git/status.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_KEY = "supi-release";
const WIDGET_KEY = "supi-release";

const BUMP_OPTIONS = [
  "patch — bug fixes only",
  "minor — new features, backwards compatible",
  "major — breaking changes",
];

// ── Release progress tracker ────────────────────────────────────

interface ReleaseStep {
  label: string;
  status: "pending" | "active" | "done" | "error" | "skipped";
  detail?: string;
}

function createReleaseProgress(ctx: any) {
  const steps: ReleaseStep[] = [
    { label: "Check working tree", status: "pending" },
    { label: "Detect channels", status: "pending" },
    { label: "Analyze commits", status: "pending" },
    { label: "Select version", status: "pending" },
    { label: "Build changelog", status: "pending" },
    { label: "Execute release", status: "pending" },
    { label: "Publish channels", status: "pending" },
  ];

  let frame = 0;
  let statusDetail = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  function icon(step: ReleaseStep): string {
    switch (step.status) {
      case "done":    return "✓";
      case "active":  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      case "error":   return "✗";
      case "skipped": return "–";
      default:        return "○";
    }
  }

  function renderWidget(): string[] {
    const lines: string[] = ["┌─ supi:release ─────────────────────┐"];
    for (const step of steps) {
      const mark = icon(step);
      const detail = step.detail ? ` (${step.detail})` : "";
      lines.push(`│ ${mark} ${step.label}${detail}`);
    }
    lines.push("└─────────────────────────────────────┘");
    return lines;
  }

  function refresh() {
    frame++;
    ctx.ui.setWidget?.(WIDGET_KEY, renderWidget());
    if (statusDetail) {
      ctx.ui.setStatus?.(STATUS_KEY, `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${statusDetail}`);
    }
  }

  function startTimer() {
    if (!timer) {
      timer = setInterval(refresh, 80);
    }
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    activate(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "active";
        step.detail = detail;
      }
      statusDetail = detail ?? step?.label ?? "";
      startTimer();
      refresh();
    },

    complete(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "done";
        if (detail !== undefined) step.detail = detail;
      }
      refresh();
    },

    fail(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "error";
        if (detail !== undefined) step.detail = detail;
      }
      refresh();
    },

    skip(stepIndex: number, detail?: string) {
      const step = steps[stepIndex];
      if (step) {
        step.status = "skipped";
        if (detail !== undefined) step.detail = detail;
      }
      refresh();
    },

    /** Build an onProgress callback for executeRelease. */
    executorProgress(): ReleaseProgressFn {
      return (step, status, detail) => {
        // Map executor steps to sub-detail on "Execute release" (index 5)
        // or "Publish channels" (index 6)
        const isPublish = step.startsWith("publish-");
        const idx = isPublish ? 6 : 5;
        if (status === "active") this.activate(idx, detail);
        else if (status === "done") {
          // Don't mark the overall step done from individual sub-steps
          const s = steps[idx];
          if (s) { s.detail = detail; }
          refresh();
        } else if (status === "error") this.fail(idx, detail);
      };
    },

    dispose() {
      stopTimer();
      ctx.ui.setStatus?.(STATUS_KEY, undefined);
      ctx.ui.setWidget?.(WIDGET_KEY, undefined);
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
export function handleRelease(platform: Platform, ctx: any, args?: string): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("Release requires interactive mode", "warning");
    return;
  }

  const progress = createReleaseProgress(ctx);

  void (async () => {
    try {
      const isPolish = args?.includes("--polish") ?? false;
      const isDryRun = args?.includes("--dry-run") ?? false;
      const config = loadConfig(platform.paths, ctx.cwd);

      // 0. Check for uncommitted changes
      progress.activate(0, "Checking working tree");
      let didStash = false;
      const treeStatus = await getWorkingTreeStatus(platform.exec.bind(platform), ctx.cwd);
      if (treeStatus.dirty) {
        progress.complete(0, `${treeStatus.files.length} files changed`);
        const filePreview = treeStatus.files.slice(0, 8).join(", ");
        const extra = treeStatus.files.length > 8 ? ` (+${treeStatus.files.length - 8} more)` : "";

        const action = await ctx.ui.select(
          `Uncommitted changes detected (${treeStatus.files.length} files)`,
          [
            "commit — commit changes with AI-generated message",
            "stash \u2014 stash changes and continue",
            "abort \u2014 cancel release",
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
          // (reactivate shows state from where we left off)
          progress.complete(0, "Committed");
        } else if (action.startsWith("stash")) {
          progress.activate(0, "Stashing changes");
          const stashResult = await platform.exec("git", ["stash", "push", "-m", "supi:release auto-stash"], { cwd: ctx.cwd });
          if (stashResult.code !== 0) {
            progress.fail(0, stashResult.stderr || "stash failed");
            progress.dispose();
            notifyError(ctx, "git stash failed", stashResult.stderr || "Non-zero exit");
            return;
          }
          didStash = true;
          progress.complete(0, "Stashed");
        }
      } else {
        progress.complete(0, "Clean");
      }

      // 1. Ensure channels are configured (or detect + ask)
      progress.activate(1, "Detecting channels");
      let channels = config.release.channels;
      if (channels.length === 0) {
        progress.complete(1, "Awaiting selection");
        channels = await setupChannels(platform, ctx);
        if (channels.length === 0) {
          progress.dispose();
          return;
        }
      }
      progress.complete(1, channels.join(", "));

      // 2. Get last tag + current version
      progress.activate(2, "Parsing git history");
      const lastTag = await getLastTag(platform, ctx.cwd);
      const currentVersion = getCurrentVersion(ctx.cwd);

      // 3. Parse commits since last tag
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
      progress.complete(2, `${commitCount} commits since ${lastTag ?? "start"}`);

      // 4. Suggest bump → UI select to confirm/override
      progress.activate(3, "Awaiting version selection");
      const suggested = suggestBump(commits);
      const bumpChoice = await ctx.ui.select(
        `Version bump (${summary})`,
        BUMP_OPTIONS,
        { helpText: `Suggested: ${suggested}` },
      );
      if (!bumpChoice) {
        progress.dispose();
        return;
      }

      const bump = bumpChoice.split(" \u2014 ")[0] as BumpType;
      const nextVersion = bumpVersion(currentVersion, bump);
      progress.complete(3, `${currentVersion} → ${nextVersion} (${bump})`);

      // 5. Build changelog
      progress.activate(4, "Generating changelog");
      const changelog = buildChangelogMarkdown(commits, nextVersion);
      progress.complete(4, `${commitCount} entries`);

      // 6. Polish mode → steer prompt to LLM, then return
      if (isPolish) {
        progress.skip(5, "Polish mode");
        progress.skip(6, "Polish mode");
        progress.dispose();

        const releaseCommands = buildReleaseCommands(nextVersion, channels);
        const prompt = buildPolishPrompt({
          changelog,
          version: nextVersion,
          currentVersion,
          channels,
          commands: releaseCommands,
        });

        notifyInfo(ctx, "Release polish mode", `LLM will polish notes for v${nextVersion}`);

        platform.sendMessage(
          {
            customType: "supi-release-polish",
            content: [{ type: "text", text: prompt }],
            display: "none",
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        return;
      }

      // 7. Confirm via UI
      const confirmLabel = isDryRun ? `[DRY RUN] Ship v${nextVersion}?` : `Ship v${nextVersion}?`;
      const confirmDetail = [
        `${currentVersion} → ${nextVersion}`,
        `Channels: ${channels.join(", ")}`,
        `Changes: ${summary}`,
        "",
        changelog,
      ].join("\n");

      const confirmed = ctx.ui.confirm
        ? await ctx.ui.confirm(confirmLabel, confirmDetail)
        : (await ctx.ui.select(confirmLabel, ["Yes \u2014 publish", "No \u2014 abort"])) === "Yes \u2014 publish";

      if (!confirmed) {
        progress.dispose();
        notifyInfo(ctx, "Release cancelled", "No changes were made");
        return;
      }

      // 8. Execute release
      progress.activate(5, "Starting release execution");
      try {
        const result = await executeRelease({
          exec: platform.exec.bind(platform),
          cwd: ctx.cwd,
          version: nextVersion,
          changelog,
          channels,
          dryRun: isDryRun,
          onProgress: progress.executorProgress(),
        });

        // Mark execution steps based on result
        if (result.tagCreated && result.pushed) {
          progress.complete(5, "Tag + push complete");
        } else if (result.error) {
          progress.fail(5, result.error);
        } else {
          progress.fail(5, `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"}`);
        }

        // Mark channel publishing
        if (result.channels.length > 0) {
          const allOk = result.channels.every((c) => c.success);
          if (allOk) {
            progress.complete(6, result.channels.map((c) => c.channel).join(", "));
          } else {
            const failedChannels = result.channels.filter((c) => !c.success);
            progress.fail(6, failedChannels.map((c) => `${c.channel}: ${c.error ?? "failed"}`).join("; "));
          }
        } else if (result.error) {
          progress.skip(6, "Skipped (release failed)");
        } else {
          progress.complete(6, "No channels");
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
        progress.fail(5, err instanceof Error ? err.message : "Unknown error");
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
    }
  })();
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

function buildReleaseCommands(
  version: string,
  channels: ReleaseChannel[],
): string[] {
  const commands: string[] = [
    `git add -A`,
    `git commit -m "release: v${version}"`,
    `git tag -a v${version} -m "Release v${version}"`,
    `git push origin HEAD --follow-tags`,
  ];

  for (const channel of channels) {
    if (channel === "github") {
      commands.push(`gh release create v${version} --title "v${version}" --notes "...changelog..."`);
    } else if (channel === "npm") {
      commands.push(`npm publish`);
    }
  }

  return commands;
}
