---
name: omp-extension-dev
description: Build OMP (Oh My Pi) extensions — slash commands, custom LLM-callable tools, event hooks, TUI primitives, and token-efficient patterns. Use this skill whenever the user wants to create, modify, debug, or scaffold an OMP extension, including writing TypeScript code that uses ExtensionAPI, pi.registerCommand, pi.registerTool, pi.on, pi.sendMessage, pi.sendUserMessage, pi.exec, ctx.ui.select, ctx.ui.notify, TypeBox schemas, or any OMP extension API. Also trigger when the user mentions ".omp/extensions", ".omp/commands", ".omp/tools", "omp extension", "pi extension", "CustomToolFactory", "SlashCommandFactory", "HookAPI", package.json with "omp.extensions" field, or asks about OMP event lifecycle (session_start, tool_call, before_agent_start, etc.). Trigger even for casual phrasing like "add a /command to my omp agent", "I want a new tool in omp", or "hook into tool calls in my extension". Do NOT trigger for: OMP user configuration (config.yml, models.yml, theme setup), Claude Code hooks (settings.json, PreToolUse), MCP server setup, SKILL.md writing, VS Code/Chrome extensions, or plain bash scripts — those are different systems.
---

# OMP Extension Development

This skill guides you through building extensions for OMP (Oh My Pi), the terminal AI coding agent. Extensions are TypeScript modules that can add slash commands, custom LLM-callable tools, event hooks, UI interactions, keyboard shortcuts, and more.

## Core Principle: Token Efficiency

The most important design principle for OMP extensions is **minimizing unnecessary LLM involvement**. Every token sent to the LLM costs time and money. A well-designed extension handles as much as possible through UI and TypeScript logic, only involving the LLM when natural language understanding is genuinely needed.

**The decision rule is simple:**
- Can it be a UI interaction (select, confirm, input)? → Do it in TypeScript
- Can it be computed deterministically (git commands, file operations, config changes)? → Do it in TypeScript
- Does it require natural language understanding, reasoning, or generation? → Then involve the LLM

For the full philosophy and decision tree, read [references/token_efficiency.md](./references/token_efficiency.md).

## What Can an Extension Do?

An extension is a TS/JS module exporting a default factory function that receives an `ExtensionAPI` object. Through this API, extensions can:

| Capability | Description | Reference |
|---|---|---|
| **Slash Commands** | User-facing `/commands` — from pure UI toggles to LLM-triggering workflows | [slash_commands.md](./references/slash_commands.md) |
| **Custom Tools** | LLM-callable functions with JSON schema parameters | [custom_tools.md](./references/custom_tools.md) |
| **Event Hooks** | Intercept session lifecycle, tool calls, agent turns, context | [event_system.md](./references/event_system.md) |
| **UI Interactions** | Dialogs, notifications, status line, widgets | [ui_primitives.md](./references/ui_primitives.md) |
| **Configuration** | CLI flags, model switching, tool restriction, settings | [api_reference.md](./references/api_reference.md) |

## Extension Structure

Extensions range from a single `.ts` file to a full npm package with dependencies.

**Single-file extension** (simplest):
```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.setLabel("My Extension");
  // register commands, tools, event handlers here
}
```

**Directory extension** (with dependencies):
```
my-extension/
  package.json      # "omp": { "extensions": ["./src/index.ts"] }
  src/index.ts
  node_modules/
```

For details on file structure, discovery locations, and loading, read [references/extension_structure.md](./references/extension_structure.md).

## Two Types of Slash Commands

This is the most common pattern in extensions. There are two distinct types:

### Type 1: UI + LLM Trigger (like `/review`)

The command shows UI to gather input, then sends a prompt to the LLM. Use `pi.sendMessage()` with `triggerTurn: true` for programmatic prompts (preferred — can be filtered from context later), or `pi.sendUserMessage()` for user-visible messages (always triggers a turn).

```typescript
pi.registerCommand("ext:review", {
  description: "Run code review with AI",
  async handler(args, ctx) {
    if (!ctx.hasUI) return; // guard for headless/SDK mode

    // Step 1: UI — gather configuration (no LLM cost)
    const scope = await ctx.ui.select("Review scope", ["staged", "all", "branch"]);
    if (!scope) return; // user cancelled

    // Step 2: Deterministic work — get changed files (no LLM cost)
    const result = await pi.exec("git", ["diff", "--name-only", "HEAD"], { cwd: ctx.cwd });
    const files = result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];

    // Step 3: Build a focused prompt and send to LLM (this is where tokens are spent)
    // Use sendMessage (not sendUserMessage) — it can be filtered from context on later turns
    pi.sendMessage(
      { customType: "review", content: [{ type: "text", text: buildPrompt(scope, files) }], display: "none" },
      { deliverAs: "steer", triggerTurn: true }
    );
  },
});
```

### Type 2: Pure UI/Config (like `/model`)

The command only uses UI and configuration APIs — no LLM involvement at all. Returns `void`.

```typescript
pi.registerCommand("ext:config", {
  description: "Manage extension settings",
  async handler(_args, ctx) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Config requires interactive mode", "warning");
      return;
    }
    const choice = await ctx.ui.select("Settings", ["Theme", "Profile", "Done"]);
    if (choice === "Theme") {
      const theme = await ctx.ui.select("Theme", ["dark", "light", "monokai"]);
      if (theme) ctx.ui.notify(`Theme set to ${theme}`, "info");
    }
    // No sendMessage, no sendUserMessage — zero LLM tokens
  },
});
```

For complete documentation with more examples, read [references/slash_commands.md](./references/slash_commands.md).

## Lifecycle & Event System

Extensions can hook into the full session lifecycle:

```typescript
// Append instructions to the system prompt before each agent turn
pi.on("before_agent_start", async () => {
  return { systemPromptAppend: "Always respond in Portuguese." };
});

// Block dangerous tool calls
pi.on("tool_call", async (event) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});
```

For the full event catalog and patterns, read [references/event_system.md](./references/event_system.md).

## Custom LLM-Callable Tools

Register tools the LLM can invoke with structured parameters:

```typescript
pi.registerTool({
  name: "count_files",
  label: "Count Files",
  description: "Count files matching a glob pattern",
  parameters: pi.typebox.Type.Object({
    glob: pi.typebox.Type.String({ description: "Glob pattern", default: "**/*.ts" }),
  }),
  async execute(toolCallId, params, onUpdate, ctx, signal) {
    const result = await pi.exec("git", ["ls-files", "--", params.glob]);
    const count = result.stdout.split("\n").filter(Boolean).length;
    return { content: [{ type: "text", text: `Found ${count} files` }] };
  },
});
```

For streaming, state management, custom rendering, and standalone tools, read [references/custom_tools.md](./references/custom_tools.md).

## Quick Reference: ExtensionAPI

| Method | Phase | Purpose |
|---|---|---|
| `pi.on(event, handler)` | Load | Subscribe to lifecycle events |
| `pi.registerTool(def)` | Load | Register LLM-callable tool |
| `pi.registerCommand(name, opts)` | Load | Register slash command |
| `pi.registerShortcut(key, opts)` | Load | Register keyboard shortcut |
| `pi.registerFlag(name, opts)` | Load | Register CLI flag |
| `pi.registerMessageRenderer(type, fn)` | Load | Custom TUI rendering for message types |
| `pi.registerProvider(name, config)` | Load | Register custom model provider |
| `pi.setLabel(label)` | Load | Set extension display name |
| `pi.sendMessage(msg, opts)` | Runtime | Inject custom message (optionally trigger LLM) |
| `pi.sendUserMessage(text)` | Runtime | Send as user message (always triggers LLM) |
| `pi.appendEntry(type, data)` | Runtime | Persist custom data to session (no LLM) |
| `pi.setActiveTools(tools)` | Runtime | Restrict/expand available tools |
| `pi.getActiveTools()` / `getAllTools()` | Runtime | List active or all registered tools |
| `pi.setModel(model)` | Runtime | Switch active model |
| `pi.getThinkingLevel()` / `setThinkingLevel()` | Runtime | Get/set reasoning level |
| `pi.getFlag(name)` | Runtime | Read a registered flag's value |
| `pi.exec(cmd, args, opts)` | Runtime | Run shell commands |
| `pi.events` | Runtime | Shared event bus for cross-extension communication |

For the complete API surface, read [references/api_reference.md](./references/api_reference.md).

## Design Checklist

Before writing an extension, run through this checklist:

1. **What triggers the workflow?** Slash command, event hook, keyboard shortcut, or CLI flag?
2. **What can be done without the LLM?** UI selection, file operations, git commands, config changes — do these first
3. **Is LLM involvement needed at all?** If the entire workflow is deterministic, skip it entirely
4. **If the LLM is needed, what's the minimal prompt?** Build a focused, pre-processed prompt with only the context the LLM needs
5. **Can you use `pi.exec()` instead of asking the LLM to use a tool?** Running `git diff` yourself is instant; asking the LLM to do it costs tokens and time

## Common Patterns

### TUI-Only Command (intercept before submission)

For commands that should never show a "Working..." spinner or create a chat message, intercept at the `input` event level:

```typescript
pi.on("input", (event, ctx) => {
  if (event.text.trim() === "/mystatus") {
    showStatusUI(ctx);
    return { handled: true }; // prevents message submission entirely
  }
});
```

### Flag + Command Combo

Register a CLI flag and a slash command that control the same behavior:

```typescript
let debugMode = false;

pi.registerFlag("debug", {
  description: "Start in debug mode",
  type: "boolean",
  handler: () => { debugMode = true; },
});

pi.registerCommand("ext:debug", {
  description: "Toggle debug mode",
  handler: async (_args, ctx) => {
    debugMode = !debugMode;
    ctx.ui.notify(`Debug mode ${debugMode ? "ON" : "OFF"}`, "info");
  },
});

// Read flag value anywhere at runtime:
const isDebug = pi.getFlag("debug"); // boolean | string | undefined
```

### Namespaced Commands

Use a prefix (e.g., `ext:`) to namespace your commands and avoid collisions with built-in or other extension commands. This is the convention used in production extensions:

```typescript
pi.registerCommand("myext:review", { /* ... */ });
pi.registerCommand("myext:config", { /* ... */ });
pi.registerCommand("myext:status", { /* ... */ });
```

### System Prompt Injection (conditional)

Append context to the system prompt only when a mode is active:

```typescript
pi.on("before_agent_start", async () => {
  if (!specialMode) return;
  return { systemPromptAppend: "You are in special mode. Follow these rules: ..." };
});
```
