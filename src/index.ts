import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { registerSupiCommand } from "./commands/supi.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerRunCommand } from "./commands/run.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerUpdateCommand } from "./commands/update.js";

function getInstalledVersion(): string | null {
  const pkgPath = join(homedir(), ".omp", "agent", "extensions", "supipowers", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return null;
  }
}

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
    // Check for updates in the background
    const currentVersion = getInstalledVersion();
    if (!currentVersion) return;

    pi.exec("npm", ["view", "supipowers", "version"], { cwd: tmpdir() })
      .then((result) => {
        if (result.exitCode !== 0) return;
        const latest = result.stdout.trim();
        if (latest && latest !== currentVersion) {
          ctx.ui.notify(
            `supipowers v${latest} available (current: v${currentVersion}). Run /supi:update`,
            "info",
          );
        }
      })
      .catch(() => {
        // Network error — silently ignore
      });
  });
}
