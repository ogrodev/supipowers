// src/release/channels/custom.ts — Wraps user-defined custom channel config into a ChannelHandler
import type { CustomChannelConfig } from "../../types.js";
import type { ChannelHandler, ChannelPublishContext, ChannelStatus, ExecFn } from "./types.js";


export function createCustomHandler(id: string, config: CustomChannelConfig): ChannelHandler {
  return {
    id,
    label: config.label,

    async detect(exec: ExecFn, cwd: string): Promise<ChannelStatus> {
      if (!config.detectCommand) {
        return { channel: id, available: true, detail: "No detect command configured — assumed available" };
      }
      try {
        const result = await exec("sh", ["-c", config.detectCommand], { cwd });
        if (result.code === 0) {
          return { channel: id, available: true, detail: `Detect command succeeded` };
        }
        return { channel: id, available: false, detail: `Detect command exited with code ${result.code}` };
      } catch {
        return { channel: id, available: false, detail: "Detect command failed to execute" };
      }
    },

    async publish(exec: ExecFn, ctx: ChannelPublishContext): Promise<{ success: boolean; error?: string }> {
      try {
        // `${tag}`/`${version}`/`${changelog}` stay in the shell template, but
        // their values cross the shell boundary via environment variables.
        const result = await exec("sh", ["-c", config.publishCommand], {
          cwd: ctx.cwd,
          env: { tag: ctx.tag, version: ctx.version, changelog: ctx.changelog },
        });
        if (result.code !== 0) {
          return { success: false, error: result.stderr || result.stdout || `Custom channel '${id}' exited with code ${result.code}` };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
