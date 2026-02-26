import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getRuntime, persistAndRender } from "./shared";

export function registerSpStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("sp-status", {
    description: "Show current Supipowers workflow status",
    async handler(_args, ctx) {
      const { config, state } = getRuntime(ctx);
      persistAndRender(ctx, config, state, "Supipowers status refreshed", "info");
    },
  });
}
