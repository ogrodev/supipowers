// src/release/executor.ts — Release execution: build, version bump, git ops, channel publishing
import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomChannelConfig, ReleaseChannel, ReleaseResult } from "../types.js";
import { commitStaged } from "../git/commit.js";
import { formatTag } from "./version.js";
import { resolveChannelHandler } from "./channels/registry.js";
import type { ExecFn } from "./channels/types.js";

/** Callback to report step progress during release execution. */
export type ReleaseProgressFn = (step: string, status: "active" | "done" | "error", detail?: string) => void;

export interface ExecuteReleaseOptions {
  exec: ExecFn;
  cwd: string;
  version: string;
  changelog: string;
  channels: ReleaseChannel[];
  dryRun: boolean;
  tagFormat: string;
  /** User-defined custom channel configurations */
  customChannels?: Record<string, CustomChannelConfig>;
  /** Skip the package.json version write (version was already set locally). */
  skipBump?: boolean;
  /** Reuse/update the local git tag after the rebase step instead of creating a new one. */
  skipTag?: boolean;
  /** Optional callback for step-by-step progress reporting. */
  onProgress?: ReleaseProgressFn;
}

/**
 * Execute a full release: optional build, package.json version bump, git
 * commit+tag+push, then per-channel publishing.
 *
 * - Build and git steps are fatal (throw or return early on non-zero exit).
 * - Channel failures are non-fatal; each is tried independently and errors
 *   are recorded in the result.
 * - In dry-run mode no exec calls are made; the result reflects what would
 *   happen (all flags true) so callers can preview without side-effects.
 */
export async function executeRelease(opts: ExecuteReleaseOptions): Promise<ReleaseResult> {
  const { exec, cwd, version, changelog, channels, dryRun, tagFormat, skipBump, skipTag, onProgress, customChannels = {} } = opts;
  const progress = onProgress ?? (() => {});
  const tagName = formatTag(version, tagFormat);
  const tagMessage = `Release ${tagName}\n\n${changelog}`;

  if (dryRun) {
    console.log(`[dry-run] Would build (if scripts.build exists)`);
    console.log(`[dry-run] Would bump version to ${version}`);
    console.log(`[dry-run] Would git add -A`);
    console.log(`[dry-run] Would git commit -m "chore(release): ${tagName}"`);
    console.log(`[dry-run] Would git pull --rebase origin`);
    if (skipTag) {
      console.log(`[dry-run] Would refresh existing git tag ${tagName} to the rebased HEAD`);
    } else {
      console.log(`[dry-run] Would git tag -a ${tagName}`);
    }
    console.log(`[dry-run] Would git push origin HEAD --follow-tags`);
    for (const ch of channels) {
      console.log(`[dry-run] Would publish to channel: ${ch}`);
    }
    return {
      version,
      tagCreated: true,
      pushed: true,
      channels: channels.map((channel) => ({ channel, success: true })),
    };
  }

  // ── 1. Optional build ─────────────────────────────────────────────────────
  const pkgPath = path.join(cwd, "package.json");
  const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;

  const scripts = pkg["scripts"] as Record<string, string> | undefined;
  if (scripts?.["build"]) {
    progress("build", "active", "Running build script");
    const buildResult = await exec("bun", ["run", "build"], { cwd });
    if (buildResult.code !== 0) {
      progress("build", "error", buildResult.stderr || "Non-zero exit");
      throw new Error(`Build failed: ${buildResult.stderr || "non-zero exit"}`);
    }
    progress("build", "done");
  }

  // ── 2. Bump version in package.json ──────────────────────────────────────
  if (skipBump) {
    progress("version-bump", "done", "Already set");
  } else {
    progress("version-bump", "active", `Bumping to ${version}`);
    pkg["version"] = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    progress("version-bump", "done");
  }

  // ── 3–6. Git operations ──────────────────────────────────────────────────

  // When skipBump is true the version was already committed locally —
  // there's nothing to stage or commit, so skip straight to tag+push.
  if (skipBump) {
    progress("git-add", "done", "Skipped (no changes)");
    progress("git-commit", "done", "Skipped (already committed)");
  } else {
    progress("git-add", "active", "git add -A");
    const gitAdd = await exec("git", ["add", "-A"], { cwd });
    if (gitAdd.code !== 0) {
      const detail = gitAdd.stderr || gitAdd.stdout || `exit code ${gitAdd.code}`;
      progress("git-add", "error", detail);
      return { version, tagCreated: false, pushed: false, channels: [], error: `git add: ${detail}` };
    }
    progress("git-add", "done");

    const commitMessage = `chore(release): ${formatTag(version, tagFormat)}`;
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

  progress("git-push", "active", "Pushing to origin");
  const gitPush = await exec("git", ["push", "origin", "HEAD", "--follow-tags"], { cwd });
  if (gitPush.code !== 0) {
    const detail = gitPush.stderr || gitPush.stdout || `exit code ${gitPush.code}`;
    progress("git-push", "error", detail);
    // Tag was created or refreshed locally but push failed
    return { version, tagCreated: true, pushed: false, channels: [], error: `git push: ${detail}` };
  }
  progress("git-push", "done");

  // ── 7. Channel publishing ─────────────────────────────────────────────────
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
      tag: formatTag(version, tagFormat),
      changelog,
      cwd,
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
