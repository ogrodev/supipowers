// src/release/detector.ts — Detect which release channels are available

import type { ReleaseChannel } from "../types.js";

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface ChannelStatus {
  channel: ReleaseChannel;
  available: boolean;
  detail: string;
}

async function checkGitHub(exec: ExecFn, cwd: string): Promise<ChannelStatus> {
  try {
    const result = await exec("gh", ["auth", "status"], { cwd });
    if (result.code === 0) {
      return { channel: "github", available: true, detail: "Authenticated with GitHub CLI" };
    }
    return {
      channel: "github",
      available: false,
      detail: "GitHub CLI not authenticated (run: gh auth login)",
    };
  } catch {
    return {
      channel: "github",
      available: false,
      detail: "GitHub CLI not authenticated (run: gh auth login)",
    };
  }
}

async function checkNpm(exec: ExecFn, cwd: string): Promise<ChannelStatus> {
  try {
    const result = await exec("npm", ["whoami"], { cwd });
    if (result.code === 0) {
      return {
        channel: "npm",
        available: true,
        detail: `Logged in as ${result.stdout.trim()}`,
      };
    }
    return {
      channel: "npm",
      available: false,
      detail: "npm not authenticated (run: npm login)",
    };
  } catch {
    return {
      channel: "npm",
      available: false,
      detail: "npm not authenticated (run: npm login)",
    };
  }
}

/**
 * Detect which release channels are available in the current environment.
 * Both checks run concurrently and independently — a failure in one does not
 * affect the other.
 */
export async function detectChannels(exec: ExecFn, cwd: string): Promise<ChannelStatus[]> {
  const [github, npm] = await Promise.all([checkGitHub(exec, cwd), checkNpm(exec, cwd)]);
  return [github, npm];
}
