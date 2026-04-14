// src/release/channels/gitlab.ts — Built-in GitLab release channel
import type { ChannelHandler, ChannelPublishContext, ChannelStatus, ExecFn } from "./types.js";

export const gitlab: ChannelHandler = {
  id: "gitlab",
  label: "GitLab Releases",

  async detect(exec: ExecFn, cwd: string): Promise<ChannelStatus> {
    try {
      const result = await exec("glab", ["auth", "status"], { cwd });
      if (result.code === 0) {
        return { channel: "gitlab", available: true, detail: "Authenticated with GitLab CLI" };
      }
      return { channel: "gitlab", available: false, detail: "GitLab CLI not authenticated (run: glab auth login)" };
    } catch {
      return { channel: "gitlab", available: false, detail: "GitLab CLI not installed (install: https://gitlab.com/gitlab-org/cli)" };
    }
  },

  async publish(exec: ExecFn, ctx: ChannelPublishContext): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await exec(
        "glab",
        ["release", "create", ctx.tag, "--notes", ctx.changelog],
        { cwd: ctx.cwd },
      );
      if (result.code !== 0) {
        return { success: false, error: result.stderr || result.stdout || `glab release create exited with code ${result.code}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
