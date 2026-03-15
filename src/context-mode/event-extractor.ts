// src/context-mode/event-extractor.ts
import type { EventCategory, EventPriority, TrackedEvent } from "./event-store.js";

type Event = Omit<TrackedEvent, "id">;

const GIT_COMMAND_PATTERNS = [
  /^git\s+(commit|merge|rebase|checkout|switch|branch|push|pull|stash|reset|cherry-pick|tag)\b/,
];

const DECISION_PATTERNS = [
  /\blet'?s?\s+go\s+with\b/i,
  /\buse\s+\S+\s+instead\s+of\b/i,
  /\bi\s+want\b/i,
  /\bgo\s+ahead\b/i,
  /^(yes|no|yep|nope|sure|ok|okay)\b/i,
  /\bdo\s+that\b/i,
  /\blet'?s?\s+do\b/i,
  /\bpick\s+(option|approach|choice)\b/i,
];

function makeEvent(
  sessionId: string,
  category: EventCategory,
  data: Record<string, unknown>,
  priority: EventPriority,
  source: string,
): Event {
  return {
    sessionId,
    category,
    data: JSON.stringify(data),
    priority,
    source,
    timestamp: Date.now(),
  };
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n")
    .slice(0, 500); // Cap for storage
}

/** Extract events from a tool result */
export function extractEvents(
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
    details: unknown;
  },
  sessionId: string,
): Event[] {
  const events: Event[] = [];
  const text = getTextContent(event.content);

  // General rule: emit error event for any isError result
  if (event.isError) {
    events.push(makeEvent(sessionId, "error", {
      toolName: event.toolName,
      content: text,
    }, "critical", "tool_result"));
  }

  switch (event.toolName) {
    case "bash":
      extractBash(events, event, sessionId, text);
      break;
    case "read":
      extractFile(events, event, sessionId, "read");
      break;
    case "edit":
      extractFile(events, event, sessionId, "edit", "high");
      break;
    case "write":
      extractFile(events, event, sessionId, "write", "high");
      break;
    case "grep":
      extractFile(events, event, sessionId, "search");
      break;
    case "find":
      extractFile(events, event, sessionId, "find");
      break;
    case "todo_write":
      events.push(makeEvent(sessionId, "task", {
        input: event.input,
      }, "high", "tool_result"));
      break;
    default:
      if (event.toolName.startsWith("ctx_")) {
        events.push(makeEvent(sessionId, "mcp", {
          tool: event.toolName,
        }, "low", "tool_result"));
      } else if (event.toolName === "task" || event.toolName === "sub_agent") {
        events.push(makeEvent(sessionId, "subagent", {
          toolName: event.toolName,
          input: event.input,
        }, "medium", "tool_result"));
      }
      // Unknown tools: no events
      break;
  }

  return events;
}

function extractBash(
  events: Event[],
  event: { input: Record<string, unknown>; details: unknown },
  sessionId: string,
  text: string,
): void {
  const command = typeof event.input.command === "string" ? event.input.command : "";
  const exitCode = event.details && typeof event.details === "object" && "exitCode" in event.details
    ? (event.details as { exitCode: number }).exitCode
    : 0;

  // Git operations
  if (GIT_COMMAND_PATTERNS.some((p) => p.test(command))) {
    events.push(makeEvent(sessionId, "git", {
      command,
      output: text,
    }, "high", "tool_result"));
  }

  // Non-zero exit (in addition to general isError rule)
  if (exitCode !== 0) {
    events.push(makeEvent(sessionId, "error", {
      command,
      exitCode,
      output: text,
    }, "critical", "tool_result"));
  }

  // Working directory change
  if (/\bcd\s+/.test(command)) {
    events.push(makeEvent(sessionId, "cwd", {
      command,
    }, "low", "tool_result"));
  }
}

function extractFile(
  events: Event[],
  event: { input: Record<string, unknown> },
  sessionId: string,
  op: string,
  priority: EventPriority = "medium",
): void {
  const path = typeof event.input.path === "string" ? event.input.path : "unknown";
  events.push(makeEvent(sessionId, "file", { op, path }, priority, "tool_result"));
}

/** Extract events from a user prompt (called from before_agent_start handler) */
export function extractPromptEvents(prompt: string, sessionId: string): Event[] {
  const events: Event[] = [];

  // Always capture the prompt
  events.push(makeEvent(sessionId, "prompt", { prompt }, "high", "before_agent_start"));

  // Check for decision patterns
  if (DECISION_PATTERNS.some((p) => p.test(prompt))) {
    events.push(makeEvent(sessionId, "decision", { prompt }, "high", "before_agent_start"));
  }

  return events;
}
