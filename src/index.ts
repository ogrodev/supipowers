import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSupiCommand } from "./commands/supi.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";

export default function supipowers(pi: ExtensionAPI): void {
  // Register base commands
  registerSupiCommand(pi);
  registerConfigCommand(pi);
  registerStatusCommand(pi);

  // Session start: check LSP and show welcome
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("supipowers", "supi ready");
    }
  });
}
