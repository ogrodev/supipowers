// src/release/channels/github.ts — Built-in GitHub release channel
import type { ChannelHandler, ChannelPublishContext, ChannelStatus, ExecFn } from "./types.js";

export const github: ChannelHandler = {
  id: "github",
  label: "GitHub Releases",

  async detect(exec: ExecFn, cwd: string): Promise<ChannelStatus> {
    try {
      const result = await exec("gh", ["auth", "status"], { cwd });
      if (result.code === 0) {
        return { channel: "github", available: true, detail: "Authenticated with GitHub CLI" };
      }
      return { channel: "github", available: false, detail: "GitHub CLI not authenticated (run: gh auth login)" };
    } catch {
      return { channel: "github", available: false, detail: "GitHub CLI not installed (install: https://cli.github.com)" };
    }
  },

  async publish(exec: ExecFn, ctx: ChannelPublishContext): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await exec(
        "gh",
        ["release", "create", ctx.tag, "--title", ctx.tag, "--notes", ctx.changelog],
        { cwd: ctx.cwd },
      );
      if (result.code !== 0) {
        return { success: false, error: result.stderr || result.stdout || `gh release create exited with code ${result.code}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
