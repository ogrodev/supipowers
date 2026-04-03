import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Platform, PlatformContext } from "../platform/types.js";
import {
  parseSystemPrompt,
  buildBreakdownItems,
  formatSectionReport,
  formatToolsReport,
} from "../context/analyzer.js";
import type { ContextUsage } from "../context/analyzer.js";

const REPORT_FILE = ".omp-context-breakdown.md";

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
    const items = buildBreakdownItems(usage, sections, activeTools, !systemPrompt);
    const lines = items.map(i => i.line);

    while (true) {
      const choice = await ctx.ui.select("Context Breakdown", lines, {
        helpText: "Select to inspect, Esc to close",
      });
      if (!choice || choice.trim() === "Close") break;

      const item = items.find(i => i.line === choice);
      if (!item || (!item.section && !item.toolNames)) continue;

      let report: string | null = null;
      if (item.section) {
        report = formatSectionReport(item.section);
      } else if (item.toolNames) {
        report = formatToolsReport(item.toolNames);
      }

      if (report) {
        const filePath = writeReport(ctx.cwd, report);
        await openInEditor(platform, filePath);
        ctx.ui.notify(`Wrote ${REPORT_FILE}`, "info");
      }
    }
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


/** Write report to project root, falling back to tmpdir on failure */
function writeReport(cwd: string, content: string): string {
  const primary = join(cwd, REPORT_FILE);
  try {
    writeFileSync(primary, content, "utf-8");
    return primary;
  } catch {
    const fallback = join(tmpdir(), REPORT_FILE);
    writeFileSync(fallback, content, "utf-8");
    return fallback;
  }
}

/** Open a file in the user's preferred editor */
async function openInEditor(platform: Platform, filePath: string): Promise<void> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  try {
    if (editor) {
      await platform.exec(editor, [filePath]);
    } else {
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start" : "xdg-open";
      await platform.exec(cmd, [filePath]);
    }
  } catch {
    // Editor open failed — non-fatal, file was still written
  }
}