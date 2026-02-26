import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExecResult } from "@mariozechner/pi-coding-agent";
import { buildReleaseNotesTemplate } from "../release/notes-template";
import {
  fillCommand,
  formatTag,
  hasReleasePipeline,
  loadReleasePipeline,
  type ReleaseCommandSpec,
  type TemplateContext,
} from "../release/pipeline-config";
import {
  bumpSemver,
  detectRecommendedBump,
  normalizeSemver,
  pickLatestSemverTag,
  type LatestTagMatch,
  type ReleaseBump,
} from "../release/versioning";

export interface SpReleaseArgs {
  version?: string;
  bump?: ReleaseBump;
  dryRun: boolean;
  yes: boolean;
  skipTests: boolean;
  skipPush: boolean;
  skipRelease: boolean;
  allowDirty: boolean;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEFAULT_RELEASE_NOTES_DIR = [".pi", "supipowers", "release-notes"];

function parseBumpValue(value: string | undefined): ReleaseBump | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "patch" || normalized === "minor" || normalized === "major") return normalized;
  return undefined;
}

export function parseReleaseArgs(args: string): SpReleaseArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const flags = new Set<string>();
  let version: string | undefined;
  let bump: ReleaseBump | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.startsWith("--bump=")) {
      bump = parseBumpValue(token.split("=")[1]);
      continue;
    }

    if (token === "--bump") {
      const maybeValue = tokens[i + 1];
      const parsed = parseBumpValue(maybeValue);
      if (parsed) {
        bump = parsed;
        i += 1;
      }
      continue;
    }

    if (token.startsWith("--")) {
      flags.add(token);
      continue;
    }

    if (!version) {
      version = token;
    }
  }

  if (version?.startsWith("v")) version = version.slice(1);

  return {
    version,
    bump,
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
    "Usage: /sp-release [version] [flags]",
    "Examples:",
    "  /sp-release",
    "  /sp-release 0.1.1",
    "  /sp-release --bump minor",
    "Requires setup: /sp-release-setup",
    "Flags:",
    "  --dry-run       Show and validate steps without mutating git/version",
    "  --yes           Skip confirmation prompt",
    "  --bump          Override auto bump strategy (patch|minor|major)",
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

async function execOptional(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  spec: ReleaseCommandSpec,
): Promise<ExecResult | undefined> {
  const result = await pi.exec(spec.command, spec.args, {
    cwd: ctx.cwd,
    timeout: spec.timeoutMs ?? 30_000,
  });
  return result.code === 0 ? result : undefined;
}

function resolveStageFiles(cwd: string, filesToStage: string[]): string[] {
  return filesToStage.filter((file) => existsSync(join(cwd, file)));
}

async function latestSemverTag(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<LatestTagMatch | undefined> {
  const result = await execOptional(pi, ctx, {
    command: "git",
    args: ["tag", "--list", "--sort=-v:refname"],
  });

  if (!result) return undefined;
  const tags = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return pickLatestSemverTag(tags);
}

function packageVersionFromFile(cwd: string): string | undefined {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: string };
    return parsed.version ? normalizeSemver(parsed.version) : undefined;
  } catch {
    return undefined;
  }
}

function parseCommitMessages(rawLog: string): string[] {
  return rawLog
    .split("\n==END==\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function collectCommitMessages(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  previousTag?: string,
): Promise<string[]> {
  const args = ["log", "--format=%s%n%b%n==END=="];
  if (previousTag) {
    args.push(`${previousTag}..HEAD`);
  }

  const result = await execOptional(pi, ctx, {
    command: "git",
    args,
    timeoutMs: 45_000,
  });

  if (!result?.stdout.trim()) return [];
  return parseCommitMessages(result.stdout);
}

function firstLines(messages: string[]): string[] {
  return messages
    .map((message) => message.split(/\r?\n/)[0]?.trim() ?? "")
    .filter((line) => line.length > 0);
}

function fallbackChangelogSection(cwd: string): string | undefined {
  const path = join(cwd, "CHANGELOG.md");
  if (!existsSync(path)) return undefined;

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => /^##\s+/.test(line));
    if (start < 0) return undefined;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }

    return lines.slice(start, end).join("\n").trim();
  } catch {
    return undefined;
  }
}

async function previousReleaseBody(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  previousTag?: string,
): Promise<string | undefined> {
  if (previousTag) {
    const result = await execOptional(pi, ctx, {
      command: "gh",
      args: ["release", "view", previousTag, "--json", "body"],
      timeoutMs: 45_000,
    });

    if (result?.stdout.trim()) {
      try {
        const parsed = JSON.parse(result.stdout) as { body?: string };
        if (parsed.body?.trim()) {
          return parsed.body.trim();
        }
      } catch {
        // fall through to changelog fallback
      }
    }
  }

  return fallbackChangelogSection(ctx.cwd);
}

function ensureReleaseNotesDraft(cwd: string, tag: string, body: string): { path: string; created: boolean } {
  const absolute = join(cwd, ...DEFAULT_RELEASE_NOTES_DIR, `${tag}.md`);
  const relativePath = relative(cwd, absolute) || absolute;

  mkdirSync(dirname(absolute), { recursive: true });

  if (!existsSync(absolute)) {
    writeFileSync(absolute, body, "utf-8");
    return { path: relativePath, created: true };
  }

  return { path: relativePath, created: false };
}

function withNotesFile(spec: ReleaseCommandSpec, notesPath: string): ReleaseCommandSpec {
  const args = [...spec.args];
  const index = args.indexOf("--notes-file");

  if (index >= 0) {
    if (index === args.length - 1) {
      args.push(notesPath);
    } else {
      args[index + 1] = notesPath;
    }
  } else {
    args.push("--notes-file", notesPath);
  }

  return {
    ...spec,
    args,
  };
}

async function tagExists(pi: ExtensionAPI, ctx: ExtensionCommandContext, tag: string): Promise<boolean> {
  const result = await execOptional(pi, ctx, {
    command: "git",
    args: ["rev-parse", "-q", "--verify", `refs/tags/${tag}`],
    timeoutMs: 20_000,
  });

  return Boolean(result);
}

interface VersionResolution {
  version: string;
  bump?: ReleaseBump;
  autoDetected: boolean;
  previousTag?: string;
  source?: "tag" | "package" | "default";
}

async function resolveReleaseVersion(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  parsed: SpReleaseArgs,
): Promise<VersionResolution | undefined> {
  if (parsed.version) {
    if (!SEMVER_PATTERN.test(parsed.version)) return undefined;
    const latest = await latestSemverTag(pi, ctx);
    return {
      version: parsed.version,
      bump: parsed.bump,
      autoDetected: false,
      previousTag: latest?.tag,
      source: latest ? "tag" : "default",
    };
  }

  const latest = await latestSemverTag(pi, ctx);
  const packageVersion = packageVersionFromFile(ctx.cwd);

  let baseVersion = "0.0.0";
  let source: VersionResolution["source"] = "default";

  if (latest) {
    baseVersion = latest.version;
    source = "tag";
  } else if (packageVersion) {
    baseVersion = packageVersion;
    source = "package";
  }

  let bump = parsed.bump;
  if (!bump) {
    if (source === "default") {
      bump = "minor";
    } else {
      const messages = await collectCommitMessages(pi, ctx, latest?.tag);
      bump = detectRecommendedBump(messages);
    }
  }

  return {
    version: bumpSemver(baseVersion, bump),
    bump,
    autoDetected: true,
    previousTag: latest?.tag,
    source,
  };
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

      const resolved = await resolveReleaseVersion(pi, ctx, parsed);
      if (!resolved) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid version input.\n${releaseUsage()}`, "error");
        }
        return;
      }

      const version = resolved.version;
      const tag = formatTag(pipeline, version);

      if (await tagExists(pi, ctx, tag)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Release blocked: tag ${tag} already exists. Choose another version.`, "error");
        }
        return;
      }

      const commitMessages = await collectCommitMessages(pi, ctx, resolved.previousTag);
      const commitSubjects = firstLines(commitMessages);
      const previousBody = await previousReleaseBody(pi, ctx, resolved.previousTag);
      const notesTemplate = buildReleaseNotesTemplate({
        version,
        tag,
        previousTag: resolved.previousTag,
        previousBody,
        commitSubjects,
      });
      const notesDraft = ensureReleaseNotesDraft(ctx.cwd, tag, notesTemplate);

      const templateContext: TemplateContext = { version, tag };
      const releaseCommand = pipeline.release
        ? withNotesFile(fillCommand(pipeline.release, templateContext), notesDraft.path)
        : undefined;

      try {
        if (!parsed.allowDirty) {
          const status = await execChecked(pi, ctx, {
            command: "git",
            args: ["status", "--porcelain"],
            timeoutMs: 30_000,
          });
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
          const lines = [
            `Proceed with release ${tag}?${parsed.dryRun ? " (dry-run)" : ""}`,
            resolved.autoDetected
              ? `Version auto-detected (${resolved.source}, bump=${resolved.bump}).`
              : "Version provided explicitly.",
            `Release notes draft: ${notesDraft.path}${notesDraft.created ? " (created)" : " (existing)"}`,
          ];

          const ok = await ctx.ui.confirm("Create release", lines.join("\n"));
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
              ...(releaseCommand ? [releaseCommand] : []),
            ]
              .map((step) => `${step.command} ${step.args.join(" ")}`)
              .join("\n");

            ctx.ui.notify(
              [
                `Dry-run complete for ${tag}.`,
                resolved.autoDetected
                  ? `Auto version: ${version} (source=${resolved.source}, bump=${resolved.bump}).`
                  : `Version: ${version}.`,
                `Release notes draft: ${notesDraft.path}${notesDraft.created ? " (created)" : " (existing)"}`,
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

        if (!parsed.skipRelease && releaseCommand) {
          if (ctx.hasUI) ctx.ui.notify("Creating release artifact...", "info");
          await execChecked(pi, ctx, releaseCommand);
        }

        if (ctx.hasUI) {
          ctx.ui.notify(
            [
              `Release ${tag} completed successfully.`,
              resolved.autoDetected
                ? `Version auto-detected (${resolved.source}, bump=${resolved.bump}).`
                : "Version provided explicitly.",
              `Release notes file: ${notesDraft.path}`,
              parsed.skipPush ? "Push skipped." : "Push completed.",
              parsed.skipRelease || !releaseCommand ? "Release creation skipped." : "Release created.",
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
