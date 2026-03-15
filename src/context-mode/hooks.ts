// src/context-mode/hooks.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SupipowersConfig } from "../types.js";
import { compressToolResult } from "./compressor.js";
import { detectContextMode, type ContextModeStatus } from "./detector.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Cached detection result
let cachedStatus: ContextModeStatus | null = null;

/** HTTP command patterns for blocking */
const HTTP_PATTERNS = [
  /^\s*curl\s/,
  /^\s*wget\s/,
  /\bcurl\s+(-[a-zA-Z]*\s+)*https?:\/\//,
  /\bwget\s+(-[a-zA-Z]*\s+)*https?:\/\//,
];

function isHttpCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return HTTP_PATTERNS.some((p) => p.test(command));
}

function loadRoutingSkill(): string | null {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const skillPath = join(__dirname, "..", "..", "skills", "context-mode", "SKILL.md");
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
}

/** Register context-mode hooks on the extension API */
export function registerContextModeHooks(pi: ExtensionAPI, config: SupipowersConfig): void {
  if (!config.contextMode.enabled) return;

  // Phase 1: Result compression
  pi.on("tool_result", (event) => {
    return compressToolResult(event, config.contextMode.compressionThreshold);
  });

  // Phase 1: Command blocking
  pi.on("tool_call", (event) => {
    if (!config.contextMode.blockHttpCommands) return;
    if (event.toolName !== "bash") return;

    const command = event.input?.command;
    if (!isHttpCommand(command)) return;

    // Only block if context-mode has a replacement tool
    if (!cachedStatus) cachedStatus = detectContextMode(pi.getActiveTools());
    if (!cachedStatus.tools.ctxFetchAndIndex) return;

    return {
      block: true,
      reason:
        "Use ctx_fetch_and_index instead of curl/wget. " +
        "It fetches the URL, indexes the content, and returns a compressed summary.",
    };
  });

  // Phase 1: Routing instructions
  pi.on("before_agent_start", (event) => {
    if (!config.contextMode.routingInstructions) return;
    if (!cachedStatus) cachedStatus = detectContextMode(pi.getActiveTools());
    if (!cachedStatus.available) return;

    const skill = loadRoutingSkill();
    if (!skill) return;

    const systemPrompt = (event as any).systemPrompt as string | undefined;
    if (!systemPrompt) return { systemPrompt: skill };
    return { systemPrompt: systemPrompt + "\n\n" + skill };
  });
}

/** Reset cached state (for testing) */
export function _resetCache(): void {
  cachedStatus = null;
}
