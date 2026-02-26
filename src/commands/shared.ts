import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config";
import { loadState, saveState } from "../storage/state-store";
import type { SupipowersConfig, WorkflowState } from "../types";
import { renderSupipowersUi } from "../ui/render";

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

  renderSupipowersUi(ctx, config, state);
  ctx.ui.notify(message, level);
}
