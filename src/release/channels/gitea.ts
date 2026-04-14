// src/release/channels/gitea.ts — Built-in Gitea/Forgejo release channel
import type { ChannelHandler, ChannelPublishContext, ChannelStatus, ExecFn } from "./types.js";

export const gitea: ChannelHandler = {
  id: "gitea",
  label: "Gitea Releases",

  async detect(exec: ExecFn, cwd: string): Promise<ChannelStatus> {
    try {
      const result = await exec("tea", ["login", "list"], { cwd });
      if (result.code === 0 && result.stdout.trim().length > 0) {
        return { channel: "gitea", available: true, detail: "Authenticated with Gitea CLI" };
      }
      return { channel: "gitea", available: false, detail: "Gitea CLI not authenticated (run: tea login add)" };
    } catch {
      return { channel: "gitea", available: false, detail: "Gitea CLI not installed (install: https://gitea.com/gitea/tea)" };
    }
  },

  async publish(exec: ExecFn, ctx: ChannelPublishContext): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await exec(
        "tea",
        ["release", "create", "--tag", ctx.tag, "--title", ctx.tag, "--note", ctx.changelog],
        { cwd: ctx.cwd },
      );
      if (result.code !== 0) {
        return { success: false, error: result.stderr || result.stdout || `tea release create exited with code ${result.code}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
