import type { Platform } from "../platform/types.js";
import { isPlanningActive } from "./approval-flow.js";

/**
 * Register a `planning_ask` tool — identical to the built-in `ask` tool
 * but with **no timeout**. OMP's built-in ask tool applies the user's
 * `ask.timeout` setting (default 30s) and only disables it for OMP's
 * native plan mode. Since `/supi:plan` is not native plan mode, planning
 * questions would auto-dismiss. This tool bypasses that limitation.
 *
 * The tool is always registered (lightweight) but the planning system
 * prompt directs the model to use it only during planning sessions.
 */
export function registerPlanningAskTool(platform: Platform): void {
  if (!platform.registerTool) return;

  platform.registerTool({
    name: "planning_ask",
    label: "Planning Question",
    description:
      "Ask the user questions during planning sessions. Use this instead of the ask tool when in /supi:plan planning mode. No timeout — the user can take as long as needed.",
    promptSnippet:
      "planning_ask — ask user questions during planning (no timeout, unlimited thinking time)",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Question text to present to the user",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Option label" },
            },
            required: ["label"],
          },
          description: "Available options for the user to choose from",
        },
        recommended: {
          type: "number",
          description: "Index of recommended option (0-indexed)",
        },
      },
      required: ["question", "options"],
    },
    async execute(
      _toolCallId: string,
      params: { question: string; options: { label: string }[]; recommended?: number },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: any,
    ) {
      const labels = params.options.map((o) => o.label);
      if (labels.length === 0) {
        return {
          content: [{ type: "text", text: "Error: options must not be empty" }],
          details: {},
        };
      }

      const choice = await ctx.ui.select(params.question, labels, {
        initialIndex: params.recommended,
        // No timeout — planning decisions need unlimited time
      });

      const selected = choice ?? labels[params.recommended ?? 0] ?? labels[0];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ question: params.question, selected }),
          },
        ],
        details: { question: params.question, selected },
      };
    },
  });
}


/**
 * Register a tool_call guard that blocks the generic `ask` tool during
 * active planning sessions and points the model at `planning_ask` instead.
 *
 * This is the runtime complement to the prompt-level directive in
 * src/planning/system-prompt.ts: even if prompt wording drifts or the model
 * ignores it, invoking `ask` during planning mode returns a block result
 * with a truthful redirection.
 */
export function registerPlanningAskToolGuard(platform: Platform): void {
  platform.on("tool_call", (event) => {
    if (!isPlanningActive()) return;
    if (event.toolName !== "ask") return;
    return {
      block: true,
      reason:
        "Planning mode: use the `planning_ask` tool instead of `ask`. `planning_ask` has no timeout so the user can think without pressure.",
    };
  });
}