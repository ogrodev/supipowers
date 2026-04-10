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
