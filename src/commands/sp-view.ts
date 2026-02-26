import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config";
import { loadState } from "../storage/state-store";
import { renderSupipowersUi } from "../ui/render";
import { buildCompactStatusLine } from "../ui/status";
import { getViewMode, setViewMode, toggleViewMode, type SupipowersViewMode } from "../ui/view-mode";

export type ViewCommandAction = "toggle" | "status" | SupipowersViewMode;

export function parseViewArgs(rawArgs: string): ViewCommandAction | undefined {
  const value = rawArgs.trim().toLowerCase();
  if (!value) return "toggle";
  if (value === "toggle") return "toggle";
  if (value === "status") return "status";
  if (value === "compact" || value === "full") return value;
  return undefined;
}

export function registerSpViewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-view", {
    description: "Toggle or set Supipowers view mode (compact/full)",
    async handler(args, ctx) {
      const action = parseViewArgs(args);
      if (!action) {
        if (ctx.hasUI) {
          ctx.ui.notify("Invalid view mode. Use: /sp-view [compact|full|toggle|status]", "warning");
        }
        return;
      }

      const config = loadConfig(ctx.cwd);
      const state = loadState(ctx.cwd);

      let nextMode = getViewMode(ctx.cwd);
      if (action === "toggle") {
        nextMode = toggleViewMode(ctx.cwd);
      } else if (action === "compact" || action === "full") {
        nextMode = setViewMode(ctx.cwd, action);
      }

      renderSupipowersUi(ctx, config, state);

      if (ctx.hasUI) {
        if (action === "status") {
          const preview = buildCompactStatusLine(state);
          ctx.ui.notify(
            `Supipowers view: ${nextMode} | config(showStatus=${config.showStatus}, showWidget=${config.showWidget}) | shortcuts: F6 / Alt+V | preview: ${preview}`,
            "info",
          );
          return;
        }

        ctx.ui.notify(
          nextMode === "compact"
            ? "Supipowers view: compact footer one-liner"
            : "Supipowers view: full status + widget",
          "info",
        );
      }
    },
  });
}
