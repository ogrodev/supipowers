import type { Platform } from "../platform/types.js";
import type { ReleaseChannel, BumpType } from "../types.js";
import { loadConfig, updateConfig } from "../config/loader.js";
import { detectChannels } from "../release/detector.js";
import { parseConventionalCommits, buildChangelogMarkdown, summarizeChanges } from "../release/changelog.js";
import { getCurrentVersion, suggestBump, bumpVersion } from "../release/version.js";
import { executeRelease } from "../release/executor.js";
import { buildPolishPrompt } from "../release/prompt.js";
import { notifyInfo, notifySuccess, notifyError } from "../notifications/renderer.js";

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
          notifyError(
            ctx,
            `Release v${nextVersion} failed`,
            `Tag: ${result.tagCreated ? "✓" : "✗"} | Push: ${result.pushed ? "✓" : "✗"}`,
          );
        }
      } catch (err) {
        notifyError(
          ctx,
          "Release failed",
          err instanceof Error ? err.message : String(err),
        );
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
