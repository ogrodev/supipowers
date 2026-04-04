// src/release/executor.ts — Release execution: build, version bump, git ops, channel publishing
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReleaseChannel, ReleaseResult } from "../types.js";
import { commitStaged } from "../git/commit.js";

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Callback to report step progress during release execution. */
export type ReleaseProgressFn = (step: string, status: "active" | "done" | "error", detail?: string) => void;

export interface ExecuteReleaseOptions {
  exec: ExecFn;
  cwd: string;
  version: string;
  changelog: string;
  channels: ReleaseChannel[];
  dryRun: boolean;
  /** Skip the package.json version write (version was already set locally). */
  skipBump?: boolean;
  /** Skip creating the git tag (it already exists locally). */
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
  const { exec, cwd, version, changelog, channels, dryRun, skipBump, skipTag, onProgress } = opts;
  const progress = onProgress ?? (() => {});

  if (dryRun) {
    console.log(`[dry-run] Would build (if scripts.build exists)`);
    console.log(`[dry-run] Would bump version to ${version}`);
    console.log(`[dry-run] Would git add -A`);
    console.log(`[dry-run] Would git commit -m "chore(release): v${version}"`);
    if (skipTag) {
      console.log(`[dry-run] Would skip git tag (already exists locally)`);
    } else {
      console.log(`[dry-run] Would git tag -a v${version}`);
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

    const commitMessage = `chore(release): v${version}`;
    progress("git-commit", "active", commitMessage);
    const commitResult = await commitStaged(exec, cwd, commitMessage);
    if (!commitResult.success) {
      progress("git-commit", "error", commitResult.error);
      return { version, tagCreated: false, pushed: false, channels: [], error: commitResult.error! };
    }
    progress("git-commit", "done");
  }

  if (skipTag) {
    progress("git-tag", "done", "Already exists");
  } else {
    progress("git-tag", "active", `v${version}`);
    const tagMessage = `Release v${version}\n\n${changelog}`;
    const gitTag = await exec("git", ["tag", "-a", `v${version}`, "-m", tagMessage], { cwd });
    if (gitTag.code !== 0) {
      const detail = gitTag.stderr || gitTag.stdout || `exit code ${gitTag.code}`;
      progress("git-tag", "error", detail);
      return { version, tagCreated: false, pushed: false, channels: [], error: `git tag: ${detail}` };
    }
    progress("git-tag", "done");
  }

  progress("git-push", "active", "Pushing to origin");
  const gitPush = await exec("git", ["push", "origin", "HEAD", "--follow-tags"], { cwd });
  if (gitPush.code !== 0) {
    const detail = gitPush.stderr || gitPush.stdout || `exit code ${gitPush.code}`;
    progress("git-push", "error", detail);
    // Tag was created locally but push failed
    return { version, tagCreated: true, pushed: false, channels: [], error: `git push: ${detail}` };
  }
  progress("git-push", "done");

  // ── 7. Channel publishing ─────────────────────────────────────────────────
  const channelResults: ReleaseResult["channels"] = [];

  for (const channel of channels) {
    progress(`publish-${channel}`, "active", `Publishing to ${channel}`);
    try {
      let result: { code: number; stdout: string; stderr: string };
      if (channel === "github") {
        result = await exec(
          "gh",
          ["release", "create", `v${version}`, "--title", `v${version}`, "--notes", changelog],
          { cwd },
        );
      } else {
        // "npm"
        result = await exec("npm", ["publish"], { cwd });
      }

      if (result.code !== 0) {
        const err = result.stderr || result.stdout || `${channel} publish exited with code ${result.code}`;
        progress(`publish-${channel}`, "error", err);
        channelResults.push({ channel, success: false, error: err });
      } else {
        progress(`publish-${channel}`, "done");
        channelResults.push({ channel, success: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress(`publish-${channel}`, "error", msg);
      channelResults.push({ channel, success: false, error: msg });
    }
  }

  return {
    version,
    tagCreated: true,
    pushed: true,
    channels: channelResults,
  };
}
