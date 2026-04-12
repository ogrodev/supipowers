# Event System

Extensions hook into OMP's lifecycle through event handlers registered via `pi.on(event, handler)`. Events let you intercept, modify, or react to everything from session management to individual tool calls.

## Table of Contents
- [How Events Work](#how-events-work)
- [Session Events](#session-events)
- [Agent Events](#agent-events)
- [Tool Events](#tool-events)
- [Context Events](#context-events)
- [Input Events](#input-events)
- [Pattern: Block Dangerous Tool Calls](#pattern-block-dangerous-tool-calls)
- [Pattern: Dynamic System Prompt](#pattern-dynamic-system-prompt)
- [Pattern: Filter Context Messages](#pattern-filter-context-messages)
- [Pattern: Session Start Notifications](#pattern-session-start-notifications)
- [Pattern: Guard Session Actions](#pattern-guard-session-actions)
- [Complete Example: Safety Extension](#complete-example-safety-extension)

---

## How Events Work

Register handlers during the extension load phase:

```typescript
pi.on("event_name", async (event, ctx) => {
  // event: event-specific data
  // ctx: ExtensionContext with UI, session manager, etc.

  // Return undefined to not interfere
  // Return an object to modify behavior (event-specific)
});
```

**Key principles:**
- Handlers run in registration order across all extensions, awaited sequentially (not concurrently)
- Return values are shallow-merged — multiple extensions can contribute different fields, but if two handlers return the same field (e.g., both return `{ block: true/false }`), later handlers overwrite earlier ones
- Returning `undefined` (or not returning) means "no opinion" — previous handler results are preserved
- Runtime methods (`pi.sendMessage`, etc.) are available inside handlers
- If a handler throws, the error is logged but does not crash the session — remaining handlers are skipped for that event

**Note:** `session.compacting` uses dot notation while all other session events use underscores (e.g., `session_start`). This is an OMP convention, not a typo — be careful when typing event names.

## Session Events

| Event | Data | Return Type | Description |
|---|---|---|---|
| `session_start` | `{}` | `void` | Session initialized |
| `session_before_switch` | `{ targetSession }` | `{ cancel?: boolean }` | About to switch sessions |
| `session_switch` | `{}` | `void` | Session switched |
| `session_before_branch` | `{ entryId }` | `{ cancel?: boolean; skipConversationRestore?: boolean }` | About to branch |
| `session_branch` | `{}` | `void` | Branch created |
| `session_before_compact` | `{}` | `{ cancel?: boolean; compaction?: CompactionResult }` | About to compact |
| `session.compacting` | `{}` | `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }` | Compaction in progress — inject context/data to preserve |
| `session_compact` | `{}` | `void` | Compaction completed |
| `session_before_tree` | `{ targetId }` | `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }` | About to navigate tree |
| `session_tree` | `{}` | `void` | Tree navigation completed |
| `session_shutdown` | `{}` | `void` | Session shutting down |

## Agent Events

| Event | Data | Return Type | Description |
|---|---|---|---|
| `before_agent_start` | `{ prompt, systemPrompt }` | `{ systemPromptAppend?: string; systemPrompt?: string }` | Before agent turn — append to or replace system prompt |
| `agent_start` | `{}` | `void` | Agent turn starting |
| `agent_end` | `{}` | `void` | Agent turn ended |

## Tool Events

| Event | Data | Return Type | Description |
|---|---|---|---|
| `tool_call` | `{ toolName, toolCallId, input }` | `{ block?: boolean; reason?: string }` | Before tool executes — can block |
| `tool_result` | `{ toolName, toolCallId, result }` | `{ content?; details?; isError? }` | After tool executes — can modify result |

## Context Events

| Event | Data | Return Type | Description |
|---|---|---|---|
| `context` | `{ messages }` | `{ messages: filtered[] }` | Transform/filter messages before LLM call |

## Input Events

| Event | Data | Return Type | Description |
|---|---|---|---|
| `input` | `{ text }` | `{ handled?: boolean }` | User typed input — return `{ handled: true }` to intercept |

---

## Pattern: Block Dangerous Tool Calls

Intercept tool calls before execution and block based on policy:

```typescript
pi.on("tool_call", async (event) => {
  // Block rm -rf commands
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    return { block: true, reason: "Destructive command blocked by safety policy" };
  }

  // Block writes to sensitive paths
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = event.input.file_path ?? event.input.filePath;
    if (path?.includes(".env") || path?.includes("credentials")) {
      return { block: true, reason: "Cannot modify sensitive files" };
    }
  }

  return undefined; // allow everything else
});
```

## Pattern: Dynamic System Prompt

Append context-sensitive instructions before each agent turn:

```typescript
let currentMode = "normal";

pi.on("before_agent_start", async () => {
  if (currentMode === "review") {
    return {
      systemPromptAppend: [
        "You are currently in code review mode.",
        "Focus on finding bugs, security issues, and style violations.",
        "Do not modify any files — only read and analyze.",
      ].join("\n"),
    };
  }
  // Return undefined when no special mode is active
});
```

You can also fully replace the system prompt using `systemPrompt` instead of `systemPromptAppend`:

```typescript
pi.on("before_agent_start", async (event) => {
  // event.systemPrompt contains the current system prompt
  return { systemPrompt: event.systemPrompt + "\n\nCustom addition." };
});
```

**Token efficiency tradeoff:** System prompt tokens are charged on *every turn*. Use `systemPromptAppend` for ongoing behavioral modes (the cost amortizes across turns). For one-shot instructions, a single `sendMessage` is cheaper than appending to every turn's system prompt.

## Pattern: Modify Tool Results

Transform tool results after execution — useful for compression, enrichment, or redaction:

```typescript
pi.on("tool_result", async (event) => {
  if (event.toolName === "bash") {
    // Compress long outputs to save context tokens
    const text = event.result?.content?.[0]?.text ?? "";
    if (text.length > 5000) {
      return {
        content: [{ type: "text", text: text.slice(0, 2000) + "\n\n... (truncated)" }],
      };
    }
  }
  return undefined;
});
```

## Pattern: Filter Context Messages

Remove or transform messages before they're sent to the LLM. Useful for keeping context lean:

```typescript
pi.on("context", async (event) => {
  // Remove debug-only messages from context
  const filtered = event.messages.filter(
    msg => !(msg.role === "custom" && msg.customType === "debug-log")
  );

  // Or limit context to recent messages only
  const recent = filtered.slice(-50);

  return { messages: recent };
});
```

## Pattern: Session Start Notifications

React when a session begins — show status, check prerequisites:

```typescript
pi.on("session_start", async (_event, ctx) => {
  // Check if required tools are available
  const tools = pi.getActiveTools();
  if (!tools.includes("lsp")) {
    ctx.ui.notify("LSP not available — some features will be limited", "warning");
  }

  // Show extension status
  ctx.ui.notify(`My Extension loaded in ${ctx.cwd}`, "info");
});
```

## Pattern: Guard Session Actions

Require confirmation before destructive session operations:

```typescript
pi.on("session_before_switch", async (_event, ctx) => {
  if (!ctx.hasUI) return; // can't confirm in headless mode

  const ok = await ctx.ui.confirm(
    "Switch session?",
    "You have unsaved work in this session"
  );
  if (!ok) return { cancel: true };
});

pi.on("session_before_compact", async (_event, ctx) => {
  const ok = await ctx.ui.confirm(
    "Compact context?",
    "This will summarize older messages"
  );
  if (!ok) return { cancel: true };
});
```

## Pattern: Preserve Data During Compaction

Inject custom context or data that should survive context compaction:

```typescript
pi.on("session.compacting", async () => {
  return {
    context: [
      "Important: The user's preferred language is Portuguese.",
      "The project uses a monorepo structure with pnpm workspaces.",
    ],
    preserveData: {
      userPreferences: { language: "pt-BR", timezone: "America/Sao_Paulo" },
    },
  };
});
```

---

## Complete Example: Safety Extension

A comprehensive safety extension combining multiple event patterns:

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PROTECTED_PATHS = [".env", ".env.local", "credentials", "secrets", ".git/config"];
// Use word-boundary-aware patterns to reduce false positives
const DANGEROUS_PATTERNS = [/\brm\s+-rf\s+\//, /\bdd\s+if=/, /\bmkfs\./, />\s*\/dev\/sd/];

export default function safetyExtension(pi: ExtensionAPI) {
  pi.setLabel("Safety Guard");
  let blockedCount = 0;

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Safety Guard active", "info");
  });

  // Block dangerous bash commands
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const cmd = event.input.command ?? "";
      const dangerous = DANGEROUS_PATTERNS.find(d => d.test(cmd));
      if (dangerous) {
        blockedCount++;
        ctx.ui.notify(`Blocked dangerous command (${blockedCount} total)`, "warning");
        return { block: true, reason: `Command matches dangerous pattern: ${dangerous}` };
      }
    }

    // Block writes to protected files
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = String(event.input.file_path ?? event.input.filePath ?? "");
      const isProtected = PROTECTED_PATHS.some(p => path.includes(p));
      if (isProtected) {
        blockedCount++;
        return { block: true, reason: `Cannot modify protected file: ${path}` };
      }
    }

    return undefined;
  });

  // Confirm before session switches
  pi.on("session_before_switch", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const ok = await ctx.ui.confirm("Switch session?", "Current session will be preserved");
    if (!ok) return { cancel: true };
  });

  // Show blocked count in status command
  pi.registerCommand("safety", {
    description: "Show safety guard status",
    async handler(_args, ctx) {
      ctx.ui.notify(`Safety Guard: ${blockedCount} actions blocked this session`, "info");
    },
  });
}
```
