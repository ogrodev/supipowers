// src/release/channels/types.ts — Shared types for release channel handlers

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface ChannelStatus {
  channel: string;
  available: boolean;
  detail: string;
}

export interface ChannelPublishContext {
  version: string;
  tag: string;
  changelog: string;
  cwd: string;
}

export interface ChannelHandler {
  id: string;
  label: string;
  detect(exec: ExecFn, cwd: string): Promise<ChannelStatus>;
  publish(exec: ExecFn, ctx: ChannelPublishContext): Promise<{ success: boolean; error?: string }>;
}
