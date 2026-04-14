// src/release/channels/registry.ts — Channel handler resolution and discovery
import type { CustomChannelConfig } from "../../types.js";
import type { ChannelHandler, ChannelStatus, ExecFn } from "./types.js";
import { github } from "./github.js";
import { gitlab } from "./gitlab.js";
import { gitea } from "./gitea.js";
import { createCustomHandler } from "./custom.js";

const BUILTIN_CHANNELS: ChannelHandler[] = [github, gitlab, gitea];

const BUILTIN_MAP = new Map(BUILTIN_CHANNELS.map((h) => [h.id, h]));

/**
 * Resolve a channel ID to a handler. Custom channel configs override built-in
 * handlers when the IDs match. Returns null for unknown IDs with no custom config.
 */
export function resolveChannelHandler(
  id: string,
  customChannels: Record<string, CustomChannelConfig>,
): ChannelHandler | null {
  if (id in customChannels) {
    return createCustomHandler(id, customChannels[id]);
  }
  return BUILTIN_MAP.get(id) ?? null;
}

/**
 * Detect availability of all built-in channels plus any custom channels.
 * Returns a status entry for each, ordered built-ins first, then custom.
 */
export async function getAllAvailableChannels(
  exec: ExecFn,
  cwd: string,
  customChannels: Record<string, CustomChannelConfig>,
): Promise<ChannelStatus[]> {
  const handlers: ChannelHandler[] = [];

  for (const builtin of BUILTIN_CHANNELS) {
    const handler = resolveChannelHandler(builtin.id, customChannels);
    if (handler) {
      handlers.push(handler);
    }
  }

  for (const [id, config] of Object.entries(customChannels)) {
    if (!BUILTIN_MAP.has(id)) {
      handlers.push(createCustomHandler(id, config));
    }
  }

  return Promise.all(handlers.map((handler) => handler.detect(exec, cwd)));
}
