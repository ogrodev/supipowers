import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExecResult } from "@mariozechner/pi-coding-agent";
import {
  fillCommand,
  formatTag,
  hasReleasePipeline,
  loadReleasePipeline,
  type ReleaseCommandSpec,
  type TemplateContext,
} from "../release/pipeline-config";

export interface SpReleaseArgs {
  version?: string;
  dryRun: boolean;
  yes: boolean;
  skipTests: boolean;
  skipPush: boolean;
  skipRelease: boolean;
  allowDirty: boolean;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseReleaseArgs(args: string): SpReleaseArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const flags = new Set(tokens.filter((token) => token.startsWith("--")));
  const positional = tokens.filter((token) => !token.startsWith("--"));

  let version = positional[0];
  if (version?.startsWith("v")) version = version.slice(1);

  return {
    version,
    dryRun: flags.has("--dry-run"),
    yes: flags.has("--yes"),
    skipTests: flags.has("--skip-tests"),
    skipPush: flags.has("--skip-push"),
    skipRelease: flags.has("--skip-release"),
    allowDirty: flags.has("--allow-dirty"),
  };
}

function releaseUsage(): string {
  return [
    "Usage: /sp-release <version> [flags]",
    "Example: /sp-release 0.1.1",
    "Requires setup: /sp-release-setup",
    "Flags:",
    "  --dry-run       Show and validate steps without mutating git/version",
    "  --yes           Skip confirmation prompt",
    "  --skip-tests    Skip validation commands from pipeline setup",
    "  --skip-push     Skip pushing main/tag",
    "  --skip-release  Skip GitHub release creation",
    "  --allow-dirty   Allow running with uncommitted changes",
  ].join("\n");
}

async function execChecked(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  spec: ReleaseCommandSpec,
): Promise<ExecResult> {
  const result = await pi.exec(spec.command, spec.args, {
    cwd: ctx.cwd,
    timeout: spec.timeoutMs ?? 180_000,
  });

  if (result.code !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Command failed: ${spec.command} ${spec.args.join(" ")}\n${detail}`.trim());
  }

  return result;
}

function resolveStageFiles(cwd: string, filesToStage: string[]): string[] {
  return filesToStage.filter((file) => existsSync(join(cwd, file)));
}

export function registerSpReleaseCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-release", {
    description: "Release using configured pipeline. Run /sp-release-setup first.",
    async handler(args, ctx) {
      const parsed = parseReleaseArgs(args);

      if (!hasReleasePipeline(ctx.cwd)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Release pipeline is not configured for this repo.\nRun /sp-release-setup first.",
            "error",
          );
        }
        return;
      }

      const pipeline = loadReleasePipeline(ctx.cwd);
      if (!pipeline) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Release pipeline config is invalid.\nRe-run /sp-release-setup to regenerate it.",
            "error",
          );
        }
        return;
      }

      if (!parsed.version || !SEMVER_PATTERN.test(parsed.version)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid or missing version.\n${releaseUsage()}`, "error");
        }
        return;
      }

      const version = parsed.version;
      const tag = formatTag(pipeline, version);
      const templateContext: TemplateContext = { version, tag };

      try {
        if (!parsed.allowDirty) {
          const status = await execChecked(pi, ctx, { command: "git", args: ["status", "--porcelain"], timeoutMs: 30_000 });
          if (status.stdout.trim().length > 0) {
            if (ctx.hasUI) {
              ctx.ui.notify(
                "Release blocked: working tree is dirty. Commit/stash changes first, or use --allow-dirty.",
                "error",
              );
            }
            return;
          }
        }

        if (!parsed.yes && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Create release",
            `Proceed with release ${tag}?${parsed.dryRun ? " (dry-run)" : ""}`,
          );
          if (!ok) {
            ctx.ui.notify("Release cancelled.", "info");
            return;
          }
        }

        if (!parsed.skipTests && pipeline.validate.length > 0) {
          if (ctx.hasUI) ctx.ui.notify("Running pipeline validation steps...", "info");
          for (const command of pipeline.validate) {
            // eslint-disable-next-line no-await-in-loop
            await execChecked(pi, ctx, fillCommand(command, templateContext));
          }
        }

        if (parsed.dryRun) {
          if (ctx.hasUI) {
            const steps = [
              ...pipeline.validate.map((step) => fillCommand(step, templateContext)),
              fillCommand(pipeline.versionBump, templateContext),
              fillCommand(pipeline.commit, templateContext),
              fillCommand(pipeline.tag, templateContext),
              ...pipeline.push.map((step) => fillCommand(step, templateContext)),
              ...(pipeline.release ? [fillCommand(pipeline.release, templateContext)] : []),
            ]
              .map((step) => `${step.command} ${step.args.join(" ")}`)
              .join("\n");

            ctx.ui.notify(
              [
                `Dry-run complete for ${tag}.`,
                "No version bump/commit/tag/push/release performed.",
                "Configured steps:",
                steps,
              ].join("\n"),
              "info",
            );
          }
          return;
        }

        if (ctx.hasUI) ctx.ui.notify(`Running version bump step for ${tag}...`, "info");
        await execChecked(pi, ctx, fillCommand(pipeline.versionBump, templateContext));

        const filesToAdd = resolveStageFiles(ctx.cwd, pipeline.filesToStage);
        if (filesToAdd.length === 0) {
          throw new Error(
            "No configured filesToStage were found. Update release.pipeline.json or run /sp-release-setup.",
          );
        }

        await execChecked(pi, ctx, { command: "git", args: ["add", ...filesToAdd] });
        await execChecked(pi, ctx, fillCommand(pipeline.commit, templateContext));
        await execChecked(pi, ctx, fillCommand(pipeline.tag, templateContext));

        if (!parsed.skipPush) {
          if (ctx.hasUI) ctx.ui.notify("Pushing release commits/tags...", "info");
          for (const command of pipeline.push) {
            // eslint-disable-next-line no-await-in-loop
            await execChecked(pi, ctx, fillCommand(command, templateContext));
          }
        }

        if (!parsed.skipRelease && pipeline.release) {
          if (ctx.hasUI) ctx.ui.notify("Creating release artifact...", "info");
          await execChecked(pi, ctx, fillCommand(pipeline.release, templateContext));
        }

        if (ctx.hasUI) {
          ctx.ui.notify(
            [
              `Release ${tag} completed successfully.`,
              parsed.skipPush ? "Push skipped." : "Push completed.",
              parsed.skipRelease || !pipeline.release ? "Release creation skipped." : "Release created.",
            ].join("\n"),
            "info",
          );
        }
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Release failed: ${error instanceof Error ? error.message : String(error)}\nCheck repo state before retrying.`,
            "error",
          );
        }
      }
    },
  });
}
