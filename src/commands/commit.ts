// src/commands/commit.ts — /supi:commit slash command
//
// TUI-only command — intercepted at the input level to prevent
// the "Working..." spinner. It never triggers the outer LLM session.

import type { Platform } from "../platform/types.js";
import type { PlatformContext } from "../platform/types.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { analyzeAndCommit } from "../git/commit.js";
import { parseTargetArg } from "../workspace/selector.js";

function stripTargetArg(args?: string): string | undefined {
  if (!args) {
    return undefined;
  }

  const stripped = args
    .replace(/(?:^|\s)--target(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))/g, " ")
    .trim();

  return stripped.length > 0 ? stripped : undefined;
}

modelRegistry.register({
  id: "commit",
  category: "command",
  label: "Commit",
  harnessRoleHint: "default",
});

/**
 * Register the command for autocomplete and /help listing.
 * Actual execution goes through handleCommit via the TUI dispatch.
 */
export function registerCommitCommand(platform: Platform): void {
  platform.registerCommand("supi:commit", {
    description: "AI-powered commit — analyzes changes and generates conventional commit messages",
    async handler() {
      // No-op: execution is handled by the TUI input interceptor.
      // This registration exists only for autocomplete and /help.
    },
  });
}

/**
 * TUI-only handler — called from the input event dispatcher in bootstrap.ts.
 * Runs the full commit flow (git ops, agent analysis, UI approval, execution)
 * without ever triggering the outer LLM session.
 */
export function handleCommit(platform: Platform, ctx: PlatformContext, args?: string): void {
  if (!ctx.hasUI) {
    ctx.ui.notify("Commit requires interactive mode", "warning");
    return;
  }

  void (async () => {
    try {
      await analyzeAndCommit(platform, ctx, {
        requestedTarget: parseTargetArg(args),
        userContext: stripTargetArg(args),
      });
    } catch (err) {
      ctx.ui.notify(`Commit error: ${(err as Error).message}`, "error");
    }
  })();
}
