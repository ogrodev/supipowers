import type { Platform } from "../platform/types.js";
import type { ReleaseChannel, BumpType } from "../types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { detectChannels } from "../release/detector.js";
import { parseConventionalCommits, buildChangelogMarkdown, summarizeChanges } from "../release/changelog.js";
import { getCurrentVersion, suggestBump, bumpVersion } from "../release/version.js";
import { executeRelease } from "../release/executor.js";
import { buildPolishPrompt } from "../release/prompt.js";
import { notifyInfo, notifySuccess, notifyError } from "../notifications/renderer.js";
import { analyzeAndCommit } from "../git/commit.js";
import { getWorkingTreeStatus } from "../git/status.js";

const BUMP_OPTIONS = [
  "patch — bug fixes only",
  "minor — new features, backwards compatible",
  "major — breaking changes",
];

export function registerReleaseCommand(platform: Platform): void {
  platform.registerCommand("supi:release", {
    description: "Release automation — version bump, changelog, publish",
    async handler(args: string | undefined, ctx: any) {
      const isPolish = args?.includes("--polish") ?? false;
      const isDryRun = args?.includes("--dry-run") ?? false;
      const config = loadConfig(platform.paths, ctx.cwd);

      // 0. Check for uncommitted changes
      let didStash = false;
      const treeStatus = await getWorkingTreeStatus(platform.exec.bind(platform), ctx.cwd);
      if (treeStatus.dirty) {
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

        if (!action || action.startsWith("abort")) return;

        if (action.startsWith("commit")) {
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
          notifyInfo(ctx, "Changes committed", "Proceeding with release");
        } else if (action.startsWith("stash")) {
          const stashResult = await platform.exec("git", ["stash", "push", "-m", "supi:release auto-stash"], { cwd: ctx.cwd });
          if (stashResult.code !== 0) {
            notifyError(ctx, "git stash failed", stashResult.stderr || "Non-zero exit");
            return;
          }
          didStash = true;
          notifyInfo(ctx, "Changes stashed", "Will pop stash after release");
        }
      }

      // 1. Ensure channels are configured (or detect + ask)
      let channels = config.release.channels;
      if (channels.length === 0) {
        channels = await setupChannels(platform, ctx);
        if (channels.length === 0) return;
      }

      // 2. Get last tag
      const lastTag = await getLastTag(platform, ctx.cwd);

      // 3. Get current version
      const currentVersion = getCurrentVersion(ctx.cwd);

      // 4. Parse commits since last tag
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

      // 5. Suggest bump → UI select to confirm/override
      const suggested = suggestBump(commits);
      const bumpChoice = await ctx.ui.select(
        `Version bump (${summary})`,
        BUMP_OPTIONS,
        { helpText: `Suggested: ${suggested}` },
      );
      if (!bumpChoice) return;

      const bump = bumpChoice.split(" — ")[0] as BumpType;

      // 6. Compute next version
      const nextVersion = bumpVersion(currentVersion, bump);

      // 7. Build changelog
      const changelog = buildChangelogMarkdown(commits, nextVersion);

      // 8. Polish mode → steer prompt to LLM, then return
      if (isPolish) {
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

      // 9. Confirm via UI
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
        : (await ctx.ui.select(confirmLabel, ["Yes — publish", "No — abort"])) === "Yes — publish";

      if (!confirmed) {
        notifyInfo(ctx, "Release cancelled", "No changes were made");
        return;
      }

      // 10. Execute release
      try {
        const result = await executeRelease({
          exec: platform.exec.bind(platform),
          cwd: ctx.cwd,
          version: nextVersion,
          changelog,
          channels,
          dryRun: isDryRun,
        });

        // Report result
        const channelSummary = result.channels
          .map((c) => `${c.channel}: ${c.success ? "\u2713" : `\u2717 ${c.error ?? "failed"}`}`)
          .join(", ");

        if (result.pushed || isDryRun) {
          const prefix = isDryRun ? "[DRY RUN] " : "";
          notifySuccess(
            ctx,
            `${prefix}Released v${nextVersion}`,
            `Tag: ${result.tagCreated ? "\u2713" : "\u2717"} | Push: ${result.pushed ? "\u2713" : "\u2717"} | ${channelSummary}`,
          );
        } else {
          notifyError(
            ctx,
            `Release v${nextVersion} failed`,
            `Tag: ${result.tagCreated ? "\u2713" : "\u2717"} | Push: ${result.pushed ? "\u2713" : "\u2717"}`,
          );
        }
      } catch (err) {
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
    },
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
