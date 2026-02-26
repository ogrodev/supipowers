import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config";
import { loadState, saveState } from "../storage/state-store";
import { buildStatusLine } from "../ui/status";
import { buildWidgetLines } from "../ui/widget";
import type { SupipowersConfig, WorkflowState } from "../types";

export function getRuntime(ctx: ExtensionCommandContext): { config: SupipowersConfig; state: WorkflowState } {
  return {
    config: loadConfig(ctx.cwd),
    state: loadState(ctx.cwd),
  };
}

export function persistAndRender(
  ctx: ExtensionCommandContext,
  config: SupipowersConfig,
  state: WorkflowState,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  saveState(ctx.cwd, state);

  if (!ctx.hasUI) return;

  if (config.showStatus) {
    ctx.ui.setStatus("supipowers", buildStatusLine(state, config.strictness));
  }

  if (config.showWidget) {
    ctx.ui.setWidget("supipowers", buildWidgetLines(state, config.strictness));
  }

  ctx.ui.notify(message, level);
}
