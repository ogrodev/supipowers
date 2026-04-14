// src/release/detector.ts — Detect which release channels are available
import type { CustomChannelConfig } from "../types.js";
import type { ChannelStatus, ExecFn } from "./channels/types.js";
import { getAllAvailableChannels } from "./channels/registry.js";

/**
 * Detect which release channels are available in the current environment.
 * Checks all built-in channels plus any user-defined custom channels.
 */
export async function detectChannels(
  exec: ExecFn,
  cwd: string,
  customChannels: Record<string, CustomChannelConfig> = {},
): Promise<ChannelStatus[]> {
  return getAllAvailableChannels(exec, cwd, customChannels);
}
