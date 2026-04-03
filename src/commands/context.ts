import type { Platform, PlatformContext } from "../platform/types.js";
import { parseSystemPrompt, buildBreakdown } from "../context/analyzer.js";
import type { ContextUsage } from "../context/analyzer.js";

export function handleContext(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    if (!ctx.hasUI) return;

    // Gather data from OMP runtime
    let usage: ContextUsage | null = null;
    try {
      const raw = (ctx as any).getContextUsage?.();
      if (raw && typeof raw === "object") {
        usage = {
          tokens: typeof raw.tokens === "number" ? raw.tokens : null,
          contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
          percent: typeof raw.percent === "number" ? raw.percent : null,
        };
      }
    } catch {
      // getContextUsage not available — continue without
    }

    let systemPrompt = "";
    try {
      systemPrompt = (ctx as any).getSystemPrompt?.() ?? "";
    } catch {
      // getSystemPrompt not available — continue without
    }

    // If we have nothing to show, notify and bail
    if (!usage && !systemPrompt) {
      ctx.ui.notify("Context data unavailable", "warning");
      return;
    }

    // Parse system prompt (may be empty)
    const sections = systemPrompt ? parseSystemPrompt(systemPrompt) : [];
    const activeTools = platform.getActiveTools();
    const lines = buildBreakdown(usage, sections, activeTools, !systemPrompt);

    await ctx.ui.select("Context Breakdown", lines, {
      helpText: "Esc to close",
    });
  })().catch((err) => {
    ctx.ui.notify(`Context error: ${(err as Error).message}`, "error");
  });
}

export function registerContextCommand(platform: Platform): void {
  platform.registerCommand("supi:context", {
    description: "Show context window breakdown — what's consuming tokens",
    async handler(_args: string | undefined, ctx: any) {
      handleContext(platform, ctx);
    },
  });
}
