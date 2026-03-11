import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSupiCommand } from "./commands/supi.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerRunCommand } from "./commands/run.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerUpdateCommand } from "./commands/update.js";

export default function supipowers(pi: ExtensionAPI): void {
  // Register all commands
  registerSupiCommand(pi);
  registerConfigCommand(pi);
  registerStatusCommand(pi);
  registerPlanCommand(pi);
  registerRunCommand(pi);
  registerReviewCommand(pi);
  registerQaCommand(pi);
  registerReleaseCommand(pi);
  registerUpdateCommand(pi);

  // Session start
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("supipowers", "supi ready");
    }
  });
}
