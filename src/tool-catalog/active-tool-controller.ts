import { createHash } from "node:crypto";
import { basename } from "node:path";
import { getMetricsStore, getSessionId } from "../context-mode/hooks.js";
import { getProjectStateDir } from "../workspace/state-paths.js";
import type { Platform } from "../platform/types.js";
import { normalizeSystemPromptBlocks, systemPromptText } from "../platform/system-prompt.js";
import type { McpRegistry } from "../mcp/types.js";
import type { SupipowersConfig } from "../types.js";
import { planActiveTools } from "./active-tool-planner.js";
import { detectContextMode } from "../context-mode/detector.js";
import { getShadowedNativeTools } from "../context-mode/routing.js";

export interface ActiveToolControllerDeps {
  loadMcpRegistryForCwd(cwd: string): McpRegistry;
  consumePendingTags(): string[];
}

type BeforeAgentStartEventLike = {
  prompt?: string;
  systemPrompt?: string | string[];
};

type BeforeAgentStartContextLike = {
  cwd?: string;
  getSystemPrompt?: () => unknown;
  getContextUsage?: () => {
    tokens?: number | null;
    contextWindow?: number | null;
    percent?: number | null;
  } | null;
};

export function registerActiveToolController(
  platform: Platform,
  config: SupipowersConfig,
  _deps: ActiveToolControllerDeps,
): void {
  if (!config.contextMode.enabled || !config.contextMode.lazyTools.enabled) return;

  platform.on("before_agent_start", async (
    event: BeforeAgentStartEventLike,
    ctx: BeforeAgentStartContextLike = {},
  ) => {
    if (typeof platform.getAllTools !== "function") return undefined;
    if (typeof platform.setActiveTools !== "function") return undefined;
    if (typeof ctx.getSystemPrompt !== "function") return undefined;

    const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    let registry: McpRegistry = { schemaVersion: 1, servers: {} };
    try {
      registry = _deps.loadMcpRegistryForCwd(cwd);
    } catch (error) {
      (platform as any).logger?.warn?.("supi-lazy-tools: failed to load MCP registry", error);
    }

    let pendingTags: string[] = [];
    try {
      pendingTags = _deps.consumePendingTags();
    } catch (error) {
      (platform as any).logger?.warn?.("supi-lazy-tools: failed to consume MCP tags", error);
    }

    let plan;
    try {
      plan = planActiveTools({
        prompt: event.prompt ?? "",
        currentActive: platform.getActiveTools(),
        allTools: platform.getAllTools(),
        lazyTools: config.contextMode.lazyTools,
        mcpServers: registry.servers,
        pendingTags,
        cacheHandlesEnabled: config.contextMode.cacheHandles.enabled,
      });
    } catch (error) {
      (platform as any).logger?.warn?.("supi-lazy-tools: active-tool planning failed", error);
      return { systemPrompt: normalizeSystemPromptBlocks(event.systemPrompt) };
    }

    // Hide native tools fully shadowed by an active ctx_* replacement.
    // Without this, the LLM sees Search/Find/Fetch in the tool catalog and
    // routinely tries them, only to receive routing-block errors. Filtering
    // here removes them from the system prompt that OMP rebuilds below.
    if (config.contextMode.enforceRouting) {
      const status = detectContextMode(plan.activeTools);
      const shadowed = new Set(getShadowedNativeTools(status));
      if (shadowed.size > 0) {
        plan.activeTools = plan.activeTools.filter((tool) => !shadowed.has(tool));
      }
    }

    if (plan.activeTools.length === 0 || arraysEqual(plan.activeTools, platform.getActiveTools())) {
      return undefined;
    }

    try {
      await platform.setActiveTools(plan.activeTools);
    } catch (error) {
      (platform as any).logger?.warn?.("supi-lazy-tools: setActiveTools failed", error);
      return { systemPrompt: normalizeSystemPromptBlocks(event.systemPrompt) };
    }

    const rebuiltPrompt = ctx.getSystemPrompt();
    const rebuiltPromptBlocks = normalizeSystemPromptBlocks(rebuiltPrompt);
    recordLazyToolsMetric({
      platform,
      cwd,
      beforePrompt: systemPromptText(event.systemPrompt),
      afterPrompt: systemPromptText(rebuiltPrompt),
      activeTools: plan.activeTools,
      contextUsage: ctx.getContextUsage?.() ?? null,
    });

    return { systemPrompt: rebuiltPromptBlocks };
  });
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}


function recordLazyToolsMetric(opts: {
  platform: Platform;
  cwd: string;
  beforePrompt: string;
  afterPrompt: string;
  activeTools: string[];
  contextUsage: { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | null;
}): void {
  const store = getMetricsStore();
  if (!store) return;

  try {
    const projectSlug = basename(getProjectStateDir(opts.platform.paths, opts.cwd));
    const sortedActiveTools = [...opts.activeTools].sort();
    const sourceHash = createHash("sha256")
      .update(projectSlug)
      .update("\0")
      .update(sortedActiveTools.join("\0"))
      .digest("hex");

    store.record({
      session_id: getSessionId(),
      ts: Date.now(),
      layer: "L7",
      tool: "(system)",
      processor: "lazy-tools",
      before_bytes: byteLength(opts.beforePrompt),
      after_bytes: byteLength(opts.afterPrompt),
      cache_hit: 0,
      unique_source_hash: sourceHash,
      context_tokens: opts.contextUsage?.tokens ?? null,
      context_window: opts.contextUsage?.contextWindow ?? null,
      context_percent: opts.contextUsage?.percent ?? null,
    });
  } catch (error) {
    (opts.platform as any).logger?.warn?.("supi-lazy-tools: metrics record failed", error);
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}