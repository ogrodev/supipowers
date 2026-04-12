# ExtensionAPI Reference

Complete reference for the `ExtensionAPI` object received by extension factory functions. This covers every method and property available to extension developers.

## Table of Contents
- [Extension Factory Signature](#extension-factory-signature)
- [Registration Methods (Load Phase)](#registration-methods-load-phase)
- [Runtime Action Methods](#runtime-action-methods)
- [Helper Properties](#helper-properties)
- [Message Delivery Semantics](#message-delivery-semantics)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionUI](#extensionui)
- [Lifecycle Constraint](#lifecycle-constraint)

---

## Extension Factory Signature

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  // Registration phase — register tools, commands, handlers, etc.
  // Do NOT call runtime methods here (sendMessage, setActiveTools, etc.)
}
```

The factory runs synchronously during module load. All registrations happen here. Runtime actions are only available inside event handlers, command handlers, and tool execute functions.

---

## Registration Methods (Load Phase)

These methods are available during the factory execution (load phase):

### `pi.on(event, handler)`

Subscribe to a lifecycle event. See [event_system.md](./event_system.md) for the full event catalog.

```typescript
pi.on("session_start", async (event, ctx) => { /* ... */ });
pi.on("tool_call", async (event, ctx) => { /* ... */ });
pi.on("before_agent_start", async () => { /* ... */ });
pi.on("input", (event, ctx) => { /* ... */ });  // intercept user input
```

### `pi.registerTool(toolDef)`

Register an LLM-callable tool. See [custom_tools.md](./custom_tools.md) for details.

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  parameters: pi.typebox.Type.Object({ /* ... */ }),
  async execute(toolCallId, params, onUpdate, ctx, signal) { /* ... */ },
});
```

### `pi.registerCommand(name, options)`

Register a slash command. See [slash_commands.md](./slash_commands.md) for details.

```typescript
pi.registerCommand("deploy", {
  description: "Deploy the project",
  getArgumentCompletions: (prefix) => [/* ... */],
  handler: async (args, ctx) => { /* ... */ },
});
```

### `pi.registerShortcut(shortcut, options)`

Register a keyboard shortcut:

```typescript
pi.registerShortcut("ctrl+shift+r", {
  description: "Quick review",
  handler: async (ctx) => {
    ctx.ui.notify("Starting quick review...", "info");
    // ...
  },
});
```

### `pi.registerFlag(name, options)`

Register a CLI flag that can be passed when launching OMP:

```typescript
pi.registerFlag("debug", {
  description: "Enable debug mode",
  type: "boolean", // or "string"
  default: false,
  handler: () => { /* called when flag is set */ },
});

// Read later in handlers:
const isDebug = pi.getFlag("debug"); // boolean | string | undefined
```

Usage: `omp --debug` or `omp --debug true`

### `pi.registerMessageRenderer(type, renderFn)`

Register a custom TUI renderer for messages of a specific `customType`:

```typescript
pi.registerMessageRenderer("deploy-status", (message, { expanded }, theme) => {
  // Return a pi-tui Component
});
```

### `pi.registerProvider(name, config)`

Register a custom model provider:

```typescript
pi.registerProvider("my-provider", {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "MY_API_KEY",
  api: "openai-completions", // or "anthropic-messages", "google-generative-ai", etc.
});
```

### `pi.setLabel(label)`

Set the display name for this extension (shown in the Extension Control Center):

```typescript
pi.setLabel("My Awesome Extension");
```

---

## Runtime Action Methods

These methods are available inside event handlers, command handlers, and tool execute functions — NOT during the load phase.

### `pi.sendMessage(message, options?)`

Inject a custom-typed message into the session:

```typescript
pi.sendMessage(
  {
    customType: "my-type",           // matches registerMessageRenderer
    content: [{ type: "text", text: "Hello" }],
    display: "none" | "custom",      // "none" = hidden, "custom" = use renderer
    details: { /* any data */ },      // persisted, accessible in renderer
    attribution: "My Extension",      // shown as message source
  },
  {
    triggerTurn: true,               // if true, starts an agent turn
    deliverAs: "steer" | "followUp" | "nextTurn",
  }
);
```

### `pi.sendUserMessage(content, options?)`

Inject as a user message — this always triggers an LLM turn:

```typescript
// Simple text
pi.sendUserMessage("Please review the code in src/auth.ts");

// With images
pi.sendUserMessage([
  { type: "text", text: "What's in this screenshot?" },
  { type: "image", source: { type: "base64", media_type: "image/png", data: base64Data } },
]);

// Delivery timing
pi.sendUserMessage("Analyze this", { deliverAs: "steer" });     // inject while streaming
pi.sendUserMessage("Now do this", { deliverAs: "followUp" });   // queue for after current turn
```

### `pi.appendEntry(customType, data?)`

Persist a custom data entry in the session without triggering an LLM turn:

```typescript
pi.appendEntry("extension-state", { mode: "review", startedAt: Date.now() });
```

### `pi.getActiveTools()`

Get the list of currently active tool names:

```typescript
const tools = pi.getActiveTools(); // ["read", "edit", "bash", "grep", ...]
```

### `pi.getAllTools()`

Get all registered tool names (including disabled ones):

```typescript
const allTools = pi.getAllTools();
```

### `pi.setActiveTools(tools)`

Restrict or expand which tools the LLM can use:

```typescript
// Read-only mode
pi.setActiveTools(["read", "grep", "find", "lsp", "web_search"]);

// Restore all tools
pi.setActiveTools(pi.getAllTools());
```

### `pi.setModel(model)`

Switch the active LLM model:

```typescript
pi.setModel("claude-sonnet-4-20250514");
pi.setModel("gpt-4o");
```

### `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`

Get or set the thinking/reasoning level:

```typescript
const level = pi.getThinkingLevel(); // "none" | "low" | "medium" | "high"
pi.setThinkingLevel("high");
```

### `pi.getFlag(name)`

Read a registered flag value at runtime:

```typescript
const debug = pi.getFlag("debug"); // boolean | string | undefined
```

### `pi.exec(command, args, options?)`

Run a shell command:

```typescript
const result = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
// result.code: exit code
// result.stdout: standard output
// result.stderr: standard error
```

### `pi.events`

Shared event bus for cross-extension communication:

```typescript
pi.events.emit("my-custom-event", { data: 123 });
pi.events.on("my-custom-event", (data) => { /* ... */ });
```

---

## Helper Properties

| Property | Type | Description |
|---|---|---|
| `pi.typebox` | Module | `@sinclair/typebox` — access `Type.Object()`, `Type.String()`, etc. |
| `pi.pi` | Module | `@oh-my-pi/pi-coding-agent` exports — `StringEnum`, `logger`, etc. |
| `pi.logger` | Logger | Shared file logger — `pi.logger.debug()`, `.warn()`, `.error()` |

---

## Message Delivery Semantics

The `deliverAs` option controls when injected messages are processed:

| Value | Behavior |
|---|---|
| (default) | Standard message delivery — queued normally |
| `"steer"` | Inject while the model is streaming — immediate influence on current turn |
| `"followUp"` | Queue for processing after the current turn completes |
| `"nextTurn"` | (sendMessage only) Deliver on the next turn |

**When to use each:**
- `"steer"` — redirect the model mid-stream (e.g., "stop and do X instead")
- `"followUp"` — chain actions after the current turn (e.g., review → then test)
- default — start a new interaction (e.g., user-initiated command)

---

## ExtensionContext

Available in event handlers as the second parameter (`ctx`):

```typescript
pi.on("session_start", async (event, ctx: ExtensionContext) => {
  ctx.ui;               // ExtensionUI — dialogs, notifications, widgets
  ctx.hasUI;            // boolean — false in headless/SDK mode
  ctx.cwd;              // string — current working directory
  ctx.sessionManager;   // read-only session manager
  ctx.modelRegistry;    // model registry
  ctx.model;            // current model info
  ctx.isIdle();         // boolean — whether agent is idle
  ctx.hasPendingMessages(); // boolean
  ctx.abort();          // abort current operation
  ctx.shutdown();       // shut down the session
  ctx.getSystemPrompt(); // get current system prompt
});
```

## ExtensionCommandContext

Extended context available in slash command handlers — includes everything from `ExtensionContext` plus session management:

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx: ExtensionCommandContext) => {
    // Everything from ExtensionContext, plus:
    ctx.getContextUsage();              // token usage info
    await ctx.waitForIdle();            // wait for agent to finish
    await ctx.newSession(options?);     // start new session
    await ctx.branch(entryId);          // branch session
    await ctx.navigateTree(targetId);   // navigate session tree
    await ctx.compact(instructions?);   // compact context
    await ctx.switchSession(path);      // switch to another session
  },
});
```

## ExtensionUI

See [ui_primitives.md](./ui_primitives.md) for complete documentation with examples.

Quick reference:

```typescript
// Dialogs (round-trip, await response)
await ctx.ui.select(title, options, dialogOptions?);
await ctx.ui.confirm(title, message, dialogOptions?);
await ctx.ui.input(title, placeholder?, dialogOptions?);
ctx.ui.onTerminalInput(handler);

// Fire-and-forget
ctx.ui.notify(message, type?);
ctx.ui.setStatus(text?);
ctx.ui.setWidget(lines?);
ctx.ui.setTitle(title?);
ctx.ui.setEditorText(text?);
ctx.ui.getEditorText();

// Theme
ctx.ui.theme;
ctx.ui.setTheme(name);
```

---

## Lifecycle Constraint

**Critical:** Calling runtime action methods (`sendMessage`, `setActiveTools`, `setModel`, etc.) during extension load throws `ExtensionRuntimeNotInitializedError`.

```typescript
// BAD — throws during load
export default function (pi: ExtensionAPI) {
  pi.sendMessage({ /* ... */ }); // ERROR!
}

// GOOD — call from event handler
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    pi.sendMessage({ /* ... */ }); // OK — runtime is initialized
  });
}
```

Register first, act later. The factory function is for setting up registrations; runtime behavior happens in response to events.
