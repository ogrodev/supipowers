import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config";
import type { StatusSnapshot } from "./types";

export function formatStatus(snapshot: StatusSnapshot): string {
  const blocker = snapshot.blocker ? ` | blocker: ${snapshot.blocker}` : "";
  return `Supipowers phase: ${snapshot.phase}${blocker} | next: ${snapshot.nextAction}`;
}

export default function registerSupipowers(pi: ExtensionAPI): void {
  pi.registerCommand("sp-status", {
    description: "Show current Supipowers workflow status",
    async handler(_args, ctx) {
      const config = loadConfig(ctx.cwd);
      const snapshot: StatusSnapshot = {
        phase: "idle",
        nextAction: "Run /sp-start to initialize a workflow",
      };
      const line = `${formatStatus(snapshot)} | strictness: ${config.strictness}`;

      if (ctx.hasUI) {
        if (config.showStatus) ctx.ui.setStatus("supipowers", line);
        ctx.ui.notify(line, "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!ctx.hasUI || !config.showStatus) return;
    ctx.ui.setStatus("supipowers", "Supipowers loaded (phase: idle)");
  });
}
