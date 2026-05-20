import type { Platform } from "../platform/types.js";
import { isPlanningActive } from "./approval-flow.js";
import { isUiDesignActive, recordUiDesignReviewApproval } from "../ui-design/session.js";

/**
 * Register a `planning_ask` tool — identical to the built-in `ask` tool
 * but with **no timeout**, regardless of the user's `ask.timeout` setting.
 * OMP 14.9.5 changed the `ask.timeout` default from 30s to 0 (wait
 * indefinitely), but a user-configured non-zero value still applies to the
 * generic `ask` tool; this wrapper keeps planning-mode questions blocking
 * for any such configuration.
 *
 * Also records the chosen option into the ui-design session ledger via
 * `recordUiDesignReviewApproval` and pairs with
 * `registerPlanningAskToolGuard`, which redirects generic `ask` calls back
 * to this tool during planning / ui-design sessions.
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

      if (ctx?.hasUI === false || typeof ctx?.ui?.select !== "function") {
        const result = {
          error: "interactive_planning_question_unavailable",
          message: "Interactive planning questions cannot be answered in this runtime. Present this question and its options to the user instead of choosing a default.",
          question: params.question,
          options: labels,
          recommended: params.recommended ?? null,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          error: true,
        };
      }


      const choice = await ctx.ui.select(params.question, labels, {
        initialIndex: params.recommended,
        // No timeout — planning decisions need unlimited time
      });

      const selected = choice ?? labels[params.recommended ?? 0] ?? labels[0];
      recordUiDesignReviewApproval(params.question, labels, selected);

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

function getAskRedirectReason(): string | null {
  if (isPlanningActive()) {
    return "Planning mode: use the `planning_ask` tool instead of `ask`. `planning_ask` has no timeout so the user can think without pressure.";
  }

  if (isUiDesignActive()) {
    return "UI-design mode: use the `planning_ask` tool instead of `ask`. The Design Director workflow requires auditable gated responses through `planning_ask`.";
  }

  return null;
}

/**
 * Register a tool_call guard that blocks the generic `ask` tool during
 * active planning or ui-design sessions and points the model at
 * `planning_ask` instead.
 *
 * This is the runtime complement to the prompt-level directive in the
 * planning and ui-design prompts: even if prompt wording drifts or the
 * model ignores it, invoking `ask` in those modes returns a block result
 * with a truthful redirection.
 */
export function registerPlanningAskToolGuard(platform: Platform): void {
  platform.on("tool_call", (event) => {
    if (event.toolName === "resolve" && isResolveApplyInput(event.input) && isPlanningActive()) {
      return {
        block: true,
        reason:
          "Planning mode: /supi:plan uses a file-based approval hook. Native OMP plan approval is blocked because it bypasses supipowers plan tracking.",
      };
    }

    if (event.toolName !== "ask") return;

    const reason = getAskRedirectReason();
    if (!reason) return;

    return {
      block: true,
      reason,
    };
  });
}

function isResolveApplyInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  return (input as { action?: unknown }).action === "apply";
}
