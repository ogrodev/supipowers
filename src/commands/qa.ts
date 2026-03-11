import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { detectAndCache } from "../qa/detector.js";
import { buildQaRunPrompt } from "../qa/runner.js";
import { notifyInfo, notifyError } from "../notifications/renderer.js";

export function registerQaCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:qa", {
    description: "Run QA pipeline (test suite, E2E)",
    async handler(args, ctx) {
      const framework = detectAndCache(ctx.cwd);

      if (!framework) {
        notifyError(
          ctx,
          "No test framework detected",
          "Configure manually: /supi:config set qa.framework vitest && /supi:config set qa.command 'npx vitest run'"
        );
        return;
      }

      let scope: "all" | "changed" | "e2e" = "all";
      let changedFiles: string[] | undefined;

      if (args?.includes("--changed")) {
        scope = "changed";
        try {
          const result = await pi.exec("git", ["diff", "--name-only", "HEAD"], { cwd: ctx.cwd });
          if (result.exitCode === 0) {
            changedFiles = result.stdout.split("\n").filter((f) => f.trim().length > 0);
          }
        } catch {
          scope = "all";
        }
      } else if (args?.includes("--e2e")) {
        scope = "e2e";
      }

      notifyInfo(ctx, "QA started", `${framework.name} | scope: ${scope}`);

      const prompt = buildQaRunPrompt(framework.command, scope, changedFiles);

      pi.sendMessage(
        {
          customType: "supi-qa",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );
    },
  });
}
