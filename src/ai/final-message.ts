// src/ai/final-message.ts
//
// Generic helpers for running a one-shot structured agent session and
// extracting the final assistant message. Lives under src/ai/ because it has
// no dependencies on review, planning, quality, or any other workflow.
//
// Consumers:
//   - src/ai/structured-output.ts (the schema-backed retry loop)
//   - src/quality/gates/ai-review.ts, src/quality/ai-setup.ts (one-shot AI)
//   - src/lsp/bridge.ts, src/docs/drift.ts, src/commands/release.ts
//
// Phase 5 / P7B will migrate the remaining one-shot consumers to the schema-
// backed runner; until then, runStructuredAgentSession is the lowest-level
// shared primitive.

import type { GateExecutionContext } from "../types.js";

export interface StructuredAgentRunOptions {
  cwd: string;
  prompt: string;
  model?: string;
  thinkingLevel?: string | null;
  timeoutMs?: number;
}

export type StructuredAgentRunResult =
  | { status: "ok"; finalText: string }
  | { status: "error"; finalText: null; error: string };

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
  }

  if (content && typeof content === "object" && "text" in content && typeof content.text === "string") {
    return content.text.trim();
  }

  return "";
}

/**
 * Walk the message list backwards and return the last assistant message text.
 * Returns null when no assistant message contains usable text.
 */
export function extractFinalAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = "role" in message ? message.role : undefined;
    if (role !== undefined && role !== "assistant") {
      continue;
    }

    const content = "content" in message ? message.content : message;
    const text = extractTextFromContent(content);
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

/**
 * Run a one-shot agent session and return the final assistant message text.
 * Disposes the session whether the prompt succeeds or throws.
 */
export async function runStructuredAgentSession(
  createAgentSession: GateExecutionContext["createAgentSession"],
  options: StructuredAgentRunOptions,
): Promise<StructuredAgentRunResult> {
  const session = await createAgentSession({
    cwd: options.cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? null,
  });

  try {
    await session.prompt(options.prompt, { expandPromptTemplates: false });
    const finalText = extractFinalAssistantText(session.state.messages);

    if (!finalText) {
      return {
        status: "error",
        finalText: null,
        error: "No final assistant message was returned.",
      };
    }

    return { status: "ok", finalText };
  } catch (error) {
    return {
      status: "error",
      finalText: null,
      error: error instanceof Error ? error.message : "Agent session failed.",
    };
  } finally {
    await session.dispose();
  }
}
