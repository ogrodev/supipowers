// src/release/executor.ts — Release execution: build, version bump, git ops, channel publishing
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReleaseChannel, ReleaseResult } from "../types.js";

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface ExecuteReleaseOptions {
  exec: ExecFn;
  cwd: string;
  version: string;
  changelog: string;
  channels: ReleaseChannel[];
  dryRun: boolean;
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
  const { exec, cwd, version, changelog, channels, dryRun } = opts;

  if (dryRun) {
    console.log(`[dry-run] Would build (if scripts.build exists)`);
    console.log(`[dry-run] Would bump version to ${version}`);
    console.log(`[dry-run] Would git add -A`);
    console.log(`[dry-run] Would git commit -m "release: v${version}"`);
    console.log(`[dry-run] Would git tag -a v${version}`);
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
    const buildResult = await exec("bun", ["run", "build"], { cwd });
    if (buildResult.code !== 0) {
      throw new Error("Build failed");
    }
  }

  // ── 2. Bump version in package.json ──────────────────────────────────────
  pkg["version"] = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  // ── 3–6. Git operations ──────────────────────────────────────────────────

  const gitAdd = await exec("git", ["add", "-A"], { cwd });
  if (gitAdd.code !== 0) {
    return { version, tagCreated: false, pushed: false, channels: [] };
  }

  const gitCommit = await exec("git", ["commit", "-m", `release: v${version}`], { cwd });
  if (gitCommit.code !== 0) {
    return { version, tagCreated: false, pushed: false, channels: [] };
  }

  const tagMessage = `Release v${version}\n\n${changelog}`;
  const gitTag = await exec("git", ["tag", "-a", `v${version}`, "-m", tagMessage], { cwd });
  if (gitTag.code !== 0) {
    return { version, tagCreated: false, pushed: false, channels: [] };
  }

  const gitPush = await exec("git", ["push", "origin", "HEAD", "--follow-tags"], { cwd });
  if (gitPush.code !== 0) {
    // Tag was created locally but push failed
    return { version, tagCreated: true, pushed: false, channels: [] };
  }

  // ── 7. Channel publishing ─────────────────────────────────────────────────
  const channelResults: ReleaseResult["channels"] = [];

  for (const channel of channels) {
    try {
      let result: { code: number; stderr: string };
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
        channelResults.push({
          channel,
          success: false,
          error: result.stderr || `${channel} publish exited with code ${result.code}`,
        });
      } else {
        channelResults.push({ channel, success: true });
      }
    } catch (err) {
      channelResults.push({
        channel,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    version,
    tagCreated: true,
    pushed: true,
    channels: channelResults,
  };
}
