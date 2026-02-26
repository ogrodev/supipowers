import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config";
import { loadState } from "../storage/state-store";
import { renderSupipowersUi } from "../ui/render";
import { toggleViewMode } from "../ui/view-mode";

const TOGGLE_SHORTCUTS = ["f6", "alt+v"] as const;

export function registerViewToggleShortcut(pi: ExtensionAPI): void {
  for (const shortcut of TOGGLE_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle Supipowers compact/full visualization",
      handler(ctx) {
        const config = loadConfig(ctx.cwd);
        const state = loadState(ctx.cwd);
        const next = toggleViewMode(ctx.cwd);

        renderSupipowersUi(ctx, config, state);

        if (ctx.hasUI) {
          ctx.ui.notify(
            next === "compact"
              ? "Supipowers view: compact footer one-liner"
              : "Supipowers view: full status + widget",
            "info",
          );
        }
      },
    });
  }
}
