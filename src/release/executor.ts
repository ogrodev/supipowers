// src/release/executor.ts — Release execution: build, version bump, git ops, channel publishing
import * as fs from "node:fs";
import type {
  CustomChannelConfig,
  ReleaseChannel,
  ReleaseResult,
  ReleaseTarget,
} from "../types.js";
import { commitStaged } from "../git/commit.js";
import { formatTag } from "./version.js";
import { resolveChannelHandler } from "./channels/registry.js";
import type { ExecFn } from "./channels/types.js";
import { getRunScriptCommand } from "./package-manager.js";

/** Callback to report step progress during release execution. */
export type ReleaseProgressFn = (step: string, status: "active" | "done" | "error", detail?: string) => void;

export interface ExecuteReleaseOptions {
  exec: ExecFn;
  /** Repository root — git and channel publish steps run here. */
  cwd: string;
  /** Selected release target whose manifest/build should be mutated. */
  target: ReleaseTarget;
  version: string;
  changelog: string;
  channels: ReleaseChannel[];
  dryRun: boolean;
  tagFormat: string;
  /** User-defined custom channel configurations */
  customChannels?: Record<string, CustomChannelConfig>;
  /** Skip the target manifest version write (version was already set locally). */
  skipBump?: boolean;
  /** Reuse/update the local git tag after the rebase step instead of creating a new one. */
  skipTag?: boolean;
  /** Optional callback for step-by-step progress reporting. */
  onProgress?: ReleaseProgressFn;
}

interface TargetManifest {
  scripts?: Record<string, string>;
  version?: string;
}

function getTargetManifestGitPath(target: ReleaseTarget): string {
  return target.relativeDir === "."
    ? "package.json"
    : `${target.relativeDir}/package.json`;
}

function readTargetManifest(target: ReleaseTarget): TargetManifest {
  return JSON.parse(fs.readFileSync(target.manifestPath, "utf-8")) as TargetManifest;
}

const PUSH_RETRY_LIMIT = 1;

export function isNonFastForwardPushError(detail: string | undefined): boolean {
  if (!detail) {
    return false;
  }

  const normalized = detail.toLowerCase();
  return normalized.includes("non-fast-forward") || normalized.includes("fetch first");
}

async function refreshReleaseTag(
  exec: ExecFn,
  cwd: string,
  tagName: string,
  tagMessage: string,
  progress: ReleaseProgressFn,
 ): Promise<{ success: true } | { success: false; error: string }> {
  progress("git-tag", "active", `Refreshing ${tagName}`);
  const gitTag = await exec("git", ["tag", "-a", "-f", tagName, "-m", tagMessage], { cwd });
  if (gitTag.code !== 0) {
    const detail = gitTag.stderr || gitTag.stdout || `exit code ${gitTag.code}`;
    progress("git-tag", "error", detail);
    return { success: false, error: `git tag: ${detail}` };
  }

  progress("git-tag", "done", "Refreshed existing tag");
  return { success: true };
}

/**
 * Execute a full release: optional build, target manifest version bump, git
 * commit+tag+push, then per-channel publishing.
 */
export async function executeRelease(opts: ExecuteReleaseOptions): Promise<ReleaseResult> {
  const {
    exec,
    cwd,
    target,
    version,
    changelog,
    channels,
    dryRun,
    tagFormat,
    skipBump,
    skipTag,
    onProgress,
    customChannels = {},
  } = opts;
  const progress = onProgress ?? (() => {});
  const tagName = formatTag(version, tagFormat);
  const tagMessage = `Release ${tagName}\n\n${changelog}`;
  const stagedPaths = [getTargetManifestGitPath(target)];

  if (dryRun) {
    console.log(`[dry-run] Would build ${target.name} in ${target.packageDir} (if scripts.build exists)`);
    console.log(`[dry-run] Would bump ${stagedPaths[0]} to ${version}`);
    console.log(`[dry-run] Would git add -- ${stagedPaths.join(" ")}`);
    console.log(`[dry-run] Would git commit -m "chore(release): ${tagName}"`);
    console.log(`[dry-run] Would git pull --rebase origin`);
    if (skipTag) {
      console.log(`[dry-run] Would refresh existing git tag ${tagName} to the rebased HEAD`);
    } else {
      console.log(`[dry-run] Would git tag -a ${tagName}`);
    }
    console.log(`[dry-run] Would git push origin HEAD --follow-tags`);
    for (const channel of channels) {
      console.log(`[dry-run] Would publish to channel: ${channel}`);
    }
    return {
      version,
      tagCreated: true,
      pushed: true,
      channels: channels.map((channel) => ({ channel, success: true })),
    };
  }

  const manifest = readTargetManifest(target);

  if (manifest.scripts?.build) {
    progress("build", "active", `Running build script for ${target.name}`);
    const buildCommand = getRunScriptCommand(target.packageManager, "build");
    const buildResult = await exec(buildCommand.command, buildCommand.args, { cwd: target.packageDir });
    if (buildResult.code !== 0) {
      progress("build", "error", buildResult.stderr || "Non-zero exit");
      throw new Error(`Build failed: ${buildResult.stderr || "non-zero exit"}`);
    }
    progress("build", "done");
  }

  if (skipBump) {
    progress("version-bump", "done", "Already set");
  } else {
    progress("version-bump", "active", `Bumping ${stagedPaths[0]} to ${version}`);
    manifest.version = version;
    fs.writeFileSync(target.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    progress("version-bump", "done");
  }

  if (skipBump) {
    progress("git-add", "done", "Skipped (no changes)");
    progress("git-commit", "done", "Skipped (already committed)");
  } else {
    progress("git-add", "active", `git add -- ${stagedPaths.join(" ")}`);
    const gitAdd = await exec("git", ["add", "--", ...stagedPaths], { cwd });
    if (gitAdd.code !== 0) {
      const detail = gitAdd.stderr || gitAdd.stdout || `exit code ${gitAdd.code}`;
      progress("git-add", "error", detail);
      return { version, tagCreated: false, pushed: false, channels: [], error: `git add: ${detail}` };
    }
    progress("git-add", "done");

    const commitMessage = `chore(release): ${tagName}`;
    progress("git-commit", "active", commitMessage);
    const commitResult = await commitStaged(exec, cwd, commitMessage);
    if (!commitResult.success) {
      progress("git-commit", "error", commitResult.error);
      return { version, tagCreated: false, pushed: false, channels: [], error: commitResult.error! };
    }
    progress("git-commit", "done");
  }

  progress("git-pull", "active", "Pulling latest from origin");
  const gitPull = await exec("git", ["pull", "--rebase", "origin"], { cwd });
  if (gitPull.code !== 0) {
    const detail = gitPull.stderr || gitPull.stdout || `exit code ${gitPull.code}`;
    progress("git-pull", "error", detail);
    return { version, tagCreated: Boolean(skipTag), pushed: false, channels: [], error: `git pull: ${detail}` };
  }
  progress("git-pull", "done");

  progress("git-tag", "active", skipTag ? `Refreshing ${tagName}` : tagName);
  const gitTag = await exec(
    "git",
    skipTag
      ? ["tag", "-a", "-f", tagName, "-m", tagMessage]
      : ["tag", "-a", tagName, "-m", tagMessage],
    { cwd },
  );
  if (gitTag.code !== 0) {
    const detail = gitTag.stderr || gitTag.stdout || `exit code ${gitTag.code}`;
    progress("git-tag", "error", detail);
    return { version, tagCreated: Boolean(skipTag), pushed: false, channels: [], error: `git tag: ${detail}` };
  }
  progress("git-tag", "done", skipTag ? "Refreshed existing tag" : undefined);

  let pushAttempt = 0;
  while (true) {
    progress("git-push", "active", pushAttempt === 0 ? "Pushing to origin" : "Retrying push after rebase");
    const gitPush = await exec("git", ["push", "origin", "HEAD", "--follow-tags"], { cwd });
    if (gitPush.code === 0) {
      progress("git-push", "done");
      break;
    }

    const detail = gitPush.stderr || gitPush.stdout || `exit code ${gitPush.code}`;
    if (pushAttempt >= PUSH_RETRY_LIMIT || !isNonFastForwardPushError(detail)) {
      progress("git-push", "error", detail);
      return { version, tagCreated: true, pushed: false, channels: [], error: `git push: ${detail}` };
    }

    pushAttempt += 1;
    progress("git-pull", "active", "Push rejected — rebasing before retry");
    const retryPull = await exec("git", ["pull", "--rebase", "origin"], { cwd });
    if (retryPull.code !== 0) {
      const retryDetail = retryPull.stderr || retryPull.stdout || `exit code ${retryPull.code}`;
      progress("git-pull", "error", retryDetail);
      return { version, tagCreated: true, pushed: false, channels: [], error: `git pull: ${retryDetail}` };
    }
    progress("git-pull", "done", "Rebased after push rejection");

    const refreshTag = await refreshReleaseTag(exec, cwd, tagName, tagMessage, progress);
    if (!refreshTag.success) {
      return { version, tagCreated: true, pushed: false, channels: [], error: refreshTag.error };
    }
  }

  const channelResults: ReleaseResult["channels"] = [];
  for (const channel of channels) {
    progress(`publish-${channel}`, "active", `Publishing to ${channel}`);

    const handler = resolveChannelHandler(channel, customChannels);
    if (!handler) {
      const err = `Unknown channel '${channel}' — no built-in handler and no custom config found`;
      progress(`publish-${channel}`, "error", err);
      channelResults.push({ channel, success: false, error: err });
      continue;
    }

    const result = await handler.publish(exec, {
      version,
      tag: tagName,
      changelog,
      cwd,
      targetName: target.name,
      targetId: target.id,
      targetPath: target.relativeDir,
      manifestPath: target.manifestPath,
      packageManager: target.packageManager,
    });

    if (result.success) {
      progress(`publish-${channel}`, "done");
      channelResults.push({ channel, success: true });
    } else {
      progress(`publish-${channel}`, "error", result.error);
      channelResults.push({ channel, success: false, error: result.error });
    }
  }

  return {
    version,
    tagCreated: true,
    pushed: true,
    channels: channelResults,
  };
}
