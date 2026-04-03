// src/commands/commit.ts — /supi:commit slash command

import type { Platform } from "../platform/types.js";
import { analyzeAndCommit } from "../git/commit.js";

export function registerCommitCommand(platform: Platform): void {
  platform.registerCommand("supi:commit", {
    description: "AI-powered commit — analyzes changes and generates conventional commit messages",
    async handler(args: string | undefined, ctx: any) {
      await analyzeAndCommit(platform, ctx, {
        userContext: args?.trim() || undefined,
      });
    },
  });
}
