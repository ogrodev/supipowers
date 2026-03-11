import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { registerSupiCommand, handleSupi } from "./commands/supi.js";
import { registerConfigCommand, handleConfig } from "./commands/config.js";
import { registerStatusCommand, handleStatus } from "./commands/status.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerRunCommand } from "./commands/run.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand } from "./commands/release.js";
import { registerUpdateCommand, handleUpdate } from "./commands/update.js";

// TUI-only commands — intercepted at the input level to prevent
// message submission and "Working..." indicator
const TUI_COMMANDS: Record<string, (pi: ExtensionAPI, ctx: any) => void> = {
  "supi": (pi, ctx) => handleSupi(pi, ctx),
  "supi:config": (_pi, ctx) => handleConfig(ctx),
  "supi:status": (_pi, ctx) => handleStatus(ctx),
  "supi:update": (pi, ctx) => handleUpdate(pi, ctx),
};

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
  // Register all commands (needed for autocomplete)
  registerSupiCommand(pi);
  registerConfigCommand(pi);
  registerStatusCommand(pi);
  registerPlanCommand(pi);
  registerRunCommand(pi);
  registerReviewCommand(pi);
  registerQaCommand(pi);
  registerReleaseCommand(pi);
  registerUpdateCommand(pi);

  // Intercept TUI-only commands at the input level — this runs BEFORE
  // message submission, so no chat message appears and no "Working..." indicator
  pi.on("input", (event, ctx) => {
    const text = event.text.trim();
    if (!text.startsWith("/")) return;

    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

    const handler = TUI_COMMANDS[commandName];
    if (!handler) return;

    handler(pi, ctx);
    return { handled: true };
  });

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
