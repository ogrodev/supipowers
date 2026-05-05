import type { Platform } from "../platform/types.js";
import type { SupipowersConfig } from "../types.js";
import { createMempalaceBridge, type MempalaceBridgeFacade } from "./bridge.js";
import { resolveDefaultWing, resolveMempalaceConfig, type ResolvedMempalaceConfig } from "./config.js";
import { getEventStore as getContextEventStore, getSessionId as getContextSessionId } from "../context-mode/hooks.js";
import { buildCompactionCheckpoint, buildShutdownDiary } from "./session-summary.js";

export interface MempalaceHooksDeps {
  createBridge?: (config: ResolvedMempalaceConfig, cwd: string) => MempalaceBridgeFacade;
  getEventStore?: () => Parameters<typeof buildCompactionCheckpoint>[0]["eventStore"];
  getSessionId?: () => string;
  now?: () => string;
}

const wakeUpCache = new Map<string, string>();

function contextCwd(ctx: unknown): string {
  return typeof ctx === "object" && ctx !== null && typeof (ctx as { cwd?: unknown }).cwd === "string"
    ? (ctx as { cwd: string }).cwd
    : process.cwd();
}

function sessionIdFrom(event: unknown, ctx: unknown): string {
  for (const source of [event, ctx]) {
    if (typeof source === "object" && source !== null) {
      const value = (source as { sessionId?: unknown }).sessionId;
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return "default-session";
}

function currentSystemPrompt(event: unknown, ctx: unknown): string {
  if (typeof ctx === "object" && ctx !== null && typeof (ctx as { getSystemPrompt?: unknown }).getSystemPrompt === "function") {
    try {
      const prompt = (ctx as { getSystemPrompt: () => unknown }).getSystemPrompt();
      if (typeof prompt === "string") return prompt;
    } catch {
      // best effort: fall back to event value
    }
  }
  return typeof event === "object" && event !== null && typeof (event as { systemPrompt?: unknown }).systemPrompt === "string"
    ? (event as { systemPrompt: string }).systemPrompt
    : "";
}

function appendPrompt(base: string, block: string): { systemPrompt: string } {
  return { systemPrompt: base ? `${base}\n\n${block}` : block };
}

function truncateByTokenBudget(text: string, tokens: number): string {
  const maxChars = Math.max(200, tokens * 4);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function wakeText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "summary", "content", "wake_up"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return JSON.stringify(result ?? {});
}

function setupGuidanceBlock(resolved: ResolvedMempalaceConfig, wing: string): string {
  return [
    "# MemPalace memory",
    `- palace: ${resolved.palacePath}`,
    `- default wing: ${wing}`,
    "- MemPalace runtime is not ready. Run `/supi:memory setup` (or call the `mempalace(action=\"setup\")` tool), then `mempalace(action=\"init\")` and `mempalace(action=\"mine\")` when appropriate.",
  ].join("\n");
}

function wakeUpBlock(resolved: ResolvedMempalaceConfig, wing: string, text: string): string {
  const excerpt = truncateByTokenBudget(text, resolved.budgets.wakeUpTokens);
  const lines = [
    "# MemPalace memory",
    `- palace: ${resolved.palacePath}`,
    `- default wing: ${wing}`,
  ];
  if (resolved.hooks.searchGuidance) {
    lines.push("- Search MemPalace before answering past-fact questions about prior decisions, people, projects, or past events.");
  }
  if (excerpt.trim()) {
    lines.push("", "## Wake-up excerpt", excerpt.trim());
  }
  return lines.join("\n");
}

export function registerMempalaceHooks(
  platform: Platform,
  config: SupipowersConfig,
  deps: MempalaceHooksDeps = {},
): void {
  if (!config.mempalace.enabled) return;

  const clearCache = () => wakeUpCache.clear();
  platform.on("session_start", clearCache);
  platform.on("session_switch", clearCache);

  platform.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    if (!config.mempalace.hooks.wakeUp && !config.mempalace.hooks.searchGuidance) return undefined;
    const cwd = contextCwd(ctx);
    const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
    let wing: string;
    try {
      wing = resolveDefaultWing(resolved, cwd, platform.paths);
    } catch {
      wing = "project";
    }
    const sessionId = sessionIdFrom(event, ctx);
    const cacheKey = `${sessionId}|${wing}|${resolved.palacePath}`;
    const basePrompt = currentSystemPrompt(event, ctx);
    const cached = wakeUpCache.get(cacheKey);
    if (cached) return appendPrompt(basePrompt, cached);

    const bridge = deps.createBridge
      ? deps.createBridge(resolved, cwd)
      : createMempalaceBridge({ cwd, config: resolved });
    const wake = await bridge.execute({ action: "wake_up", wing, timeout: resolved.timeouts.hookMs });
    const block = wake.ok
      ? wakeUpBlock(resolved, wing, wakeText(wake.result))
      : setupGuidanceBlock(resolved, wing);
    wakeUpCache.set(cacheKey, block);
    return appendPrompt(basePrompt, block);
  });

  if (config.mempalace.hooks.compactionCheckpoint) {
    platform.on("session_before_compact", async (_event: unknown, ctx: unknown) => {
      try {
        const cwd = contextCwd(ctx);
        const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
        let wing: string;
        try {
          wing = resolveDefaultWing(resolved, cwd, platform.paths);
        } catch {
          wing = "project";
        }
        const sessionId = deps.getSessionId?.() ?? getContextSessionId();
        const checkpoint = buildCompactionCheckpoint({
          cwd,
          sessionId,
          wing,
          defaultAgentName: resolved.defaultAgentName,
          now: deps.now?.(),
          eventStore: deps.getEventStore?.() ?? getContextEventStore(),
          maxChars: resolved.budgets.diaryChars,
        });
        const bridge = deps.createBridge
          ? deps.createBridge(resolved, cwd)
          : createMempalaceBridge({ cwd, config: resolved });
        await bridge.execute({
          action: "add_drawer",
          wing: checkpoint.metadata.wing,
          room: checkpoint.metadata.room,
          content: checkpoint.content,
          added_by: checkpoint.metadata.added_by,
          source_file: checkpoint.metadata.source_file,
          timeout: resolved.timeouts.hookMs,
        });
      } catch {
        // Compaction must never be cancelled by MemPalace checkpoint failures.
      }
      return undefined;
    });
  }

  if (config.mempalace.hooks.shutdownDiary) {
    platform.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
      try {
        const cwd = contextCwd(ctx);
        const resolved = resolveMempalaceConfig(config, cwd, platform.paths);
        let wing: string;
        try {
          wing = resolveDefaultWing(resolved, cwd, platform.paths);
        } catch {
          wing = "project";
        }
        const sessionId = deps.getSessionId?.() ?? getContextSessionId();
        const diary = buildShutdownDiary({
          cwd,
          sessionId,
          wing,
          defaultAgentName: resolved.defaultAgentName,
          now: deps.now?.(),
          eventStore: deps.getEventStore?.() ?? getContextEventStore(),
          maxChars: resolved.budgets.diaryChars,
        });
        const bridge = deps.createBridge
          ? deps.createBridge(resolved, cwd)
          : createMempalaceBridge({ cwd, config: resolved });
        await bridge.execute({
          action: "diary_write",
          agent_name: diary.metadata.agent_name,
          wing: diary.metadata.wing,
          topic: diary.metadata.topic,
          entry: diary.entry,
          source_file: diary.metadata.source_file,
          timeout: resolved.timeouts.hookMs,
        });
      } catch {
        // Shutdown must never be delayed or failed by MemPalace diary writes.
      }
      return undefined;
    });
  }
}
