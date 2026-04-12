# Slash Commands

Slash commands are the primary way users interact with extensions. OMP supports three forms of slash commands, each suited to a different level of complexity.

## Table of Contents
- [Three Forms of Slash Commands](#three-forms-of-slash-commands)
- [Form 1: Markdown Commands (prompt-only)](#form-1-markdown-commands-prompt-only)
- [Form 2: TypeScript Standalone Commands](#form-2-typescript-standalone-commands)
- [Form 3: Extension-Registered Commands](#form-3-extension-registered-commands)
- [The Two Behavioral Types](#the-two-behavioral-types)
- [Example A: /review — UI + LLM Trigger](#example-a-review--ui--llm-trigger)
- [Example B: /model — Pure UI/Config](#example-b-model--pure-uiconfig)
- [TUI-Only Commands (Input Interception)](#tui-only-commands-input-interception)
- [Argument Completions](#argument-completions)
- [Subcommand Pattern](#subcommand-pattern)
- [Namespacing Commands](#namespacing-commands)
- [The Async Fire-and-Forget Pattern](#the-async-fire-and-forget-pattern)
- [sendMessage vs sendUserMessage](#sendmessage-vs-senduseremessage)
- [Choosing the Right Form](#choosing-the-right-form)

---

## Three Forms of Slash Commands

| Form | Complexity | LLM Required? | Location |
|---|---|---|---|
| **Markdown** | Minimal | Always (it's a prompt) | `.omp/commands/*.md` |
| **TypeScript standalone** | Medium | Optional | `.omp/commands/[name]/index.ts` |
| **Extension-registered** | Full | Optional | Inside extension via `pi.registerCommand()` |

## Form 1: Markdown Commands (prompt-only)

The simplest form. A markdown file whose content is sent directly as an LLM prompt when invoked. Good for simple prompt templates.

**Location:** `~/.omp/agent/commands/*.md` or `<cwd>/.omp/commands/*.md`

```markdown
<!-- .omp/commands/explain.md -->
Explain the following code in detail, covering:
- What it does
- Why it's structured this way
- Any potential issues

$ARGUMENTS
```

Usage: `/explain src/auth.ts` — replaces `$ARGUMENTS` with `src/auth.ts` and sends to the LLM.

**When to use:** Only when you want a simple prompt template with no UI or logic. Every invocation consumes LLM tokens.

**When NOT to use:** If you can gather information via UI first or do any preprocessing. A TypeScript command that builds a focused prompt from UI input will be far more token-efficient than a generic markdown template.

## Form 2: TypeScript Standalone Commands

A directory under `.omp/commands/` with an `index.ts` exporting a `SlashCommandFactory`:

```typescript
// .omp/commands/deploy/index.ts
import type { SlashCommandFactory } from "@oh-my-pi/pi-coding-agent";

const factory: SlashCommandFactory = () => ({
  name: "deploy",
  description: "Deploy to an environment",
  execute: async (args, ctx) => {
    const env = await ctx.ui.select("Environment:", ["staging", "production"]);
    if (!env) return; // cancelled — no LLM involvement

    if (env === "production") {
      const ok = await ctx.ui.confirm("Deploy to PRODUCTION?", "This is irreversible");
      if (!ok) return; // cancelled — no LLM involvement
    }

    // Returning a string triggers the LLM with that string as the prompt
    return `Deploy the project to ${env} environment. Run the deploy script at ./scripts/deploy.sh --env ${env}`;
  },
});
export default factory;
```

**Return values:**
- Return `string` → sent as LLM prompt (triggers an agent turn, costs tokens)
- Return `void`/`undefined` → fire-and-forget (no LLM, zero token cost)

**Location:** `~/.omp/agent/commands/[name]/index.ts` or `<cwd>/.omp/commands/[name]/index.ts`

## Form 3: Extension-Registered Commands

Registered inside an extension's factory function via `pi.registerCommand()`. This is the most powerful form because you have access to the full `ExtensionAPI`.

```typescript
pi.registerCommand("mytool", {
  description: "Do something useful",
  handler: async (args, ctx) => {
    // Full access to pi.sendMessage, pi.exec, pi.setActiveTools, etc.
  },
});
```

**Signature:**
```typescript
pi.registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ label: string; value: string }>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
});
```

The handler always returns `void`. To trigger the LLM from here, use `pi.sendMessage()` or `pi.sendUserMessage()` explicitly.

---

## The Two Behavioral Types

Regardless of which form you use, every command falls into one of two behavioral categories:

### Type 1: UI + LLM Trigger
The command gathers input via UI, does preprocessing, then sends a prompt to the LLM. Token cost is proportional to the prompt you build.

**Key mechanism:** `pi.sendMessage()` with `triggerTurn: true`, or `pi.sendUserMessage()`.

### Type 2: Pure UI/Config
The command only uses UI primitives and configuration APIs. No LLM involvement. Zero token cost.

**Key mechanism:** Only uses `ctx.ui.*` methods, `pi.setActiveTools()`, `pi.setModel()`, file I/O, etc. Never calls `sendMessage` or `sendUserMessage`.

---

## Example A: /review — UI + LLM Trigger

This is a real-world pattern from a production extension. The command:
1. Shows a UI selector to pick review depth (no LLM cost)
2. Runs `git diff` to get changed files (no LLM cost)
3. Checks if LSP is available (no LLM cost)
4. Builds a focused prompt with only relevant context (minimal LLM cost)

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function reviewExtension(pi: ExtensionAPI) {
  pi.setLabel("Code Review");

  pi.registerCommand("review", {
    description: "Run quality review at chosen depth",
    async handler(args, ctx) {
      // ---- STEP 1: UI — gather configuration (zero LLM tokens) ----
      let profile = args?.trim();
      if (!profile && ctx.hasUI) {
        const choice = await ctx.ui.select(
          "Review profile",
          ["quick", "thorough", "full-regression"],
          { helpText: "Select review depth · Esc to cancel" },
        );
        if (!choice) return; // user cancelled
        profile = choice;
      }
      profile ??= "thorough";

      // ---- STEP 2: Deterministic work — get context (zero LLM tokens) ----
      let changedFiles: string[] = [];
      try {
        const result = await pi.exec("git", ["diff", "--name-only", "HEAD"], { cwd: ctx.cwd });
        if (result.code === 0) {
          changedFiles = result.stdout.split("\n").map(f => f.trim()).filter(Boolean);
        }
      } catch {
        // continue without file filtering
      }

      if (changedFiles.length === 0) {
        ctx.ui.notify("No changed files detected — reviewing all files in scope", "info");
      }

      // ---- STEP 3: Build focused prompt and trigger LLM ----
      const prompt = [
        `Review the code at depth: ${profile}.`,
        changedFiles.length > 0
          ? `Focus on these changed files:\n${changedFiles.map(f => `- ${f}`).join("\n")}`
          : "Review the most recently modified files.",
        "Check for: bugs, security issues, performance problems, and style violations.",
      ].join("\n\n");

      ctx.ui.notify(`Review started (${profile})`, "info");

      // This triggers the LLM — only now are tokens consumed
      pi.sendMessage(
        {
          customType: "code-review",
          content: [{ type: "text", text: prompt }],
          display: "none", // don't show the raw prompt in chat
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });
}
```

**Token efficiency:** The UI selection and git operations cost zero tokens. Only the final prompt goes to the LLM, and it's focused on exactly what changed rather than asking the LLM to figure that out.

---

## Example B: /model — Pure UI/Config

This command changes settings purely through UI — no LLM involvement at all. It's modeled after the built-in `/model` command.

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function settingsExtension(pi: ExtensionAPI) {
  pi.setLabel("Quick Settings");

  // TUI-only command — intercept at input level to prevent "Working..." spinner
  pi.on("input", (event, ctx) => {
    const text = event.text.trim();
    if (text !== "/qsettings") return;

    void showSettingsUI(pi, ctx);
    return { handled: true };
  });

  // Still register the command for autocomplete and /help listing
  pi.registerCommand("qsettings", {
    description: "Quick settings panel (model, thinking, tools)",
    async handler(_args, ctx) {
      await showSettingsUI(pi, ctx);
    },
  });
}

async function showSettingsUI(pi: ExtensionAPI, ctx: any) {
  while (true) {
    const choice = await ctx.ui.select("Quick Settings", [
      "Change model",
      "Thinking level",
      "Toggle tools",
      "Done",
    ], { helpText: "Esc to close" });

    if (!choice || choice === "Done") break;

    switch (choice) {
      case "Change model": {
        const model = await ctx.ui.select("Model", [
          "claude-sonnet-4-20250514",
          "claude-opus-4-20250514",
          "gpt-4o",
          "gemini-2.5-pro",
        ]);
        if (model) {
          pi.setModel(model);
          ctx.ui.notify(`Model → ${model}`, "info");
        }
        break;
      }
      case "Thinking level": {
        const level = await ctx.ui.select("Thinking Level", ["none", "low", "medium", "high"]);
        if (level) {
          pi.setThinkingLevel(level);
          ctx.ui.notify(`Thinking → ${level}`, "info");
        }
        break;
      }
      case "Toggle tools": {
        const allTools = pi.getAllTools();
        const activeTools = new Set(pi.getActiveTools());
        const options = allTools.map(t => `${activeTools.has(t) ? "[ON]" : "[OFF]"} ${t}`);
        options.push("Back");

        const selected = await ctx.ui.select("Tools", options);
        if (selected && selected !== "Back") {
          const toolName = selected.replace(/^\[(ON|OFF)\] /, "");
          if (activeTools.has(toolName)) {
            activeTools.delete(toolName);
          } else {
            activeTools.add(toolName);
          }
          pi.setActiveTools([...activeTools]);
          ctx.ui.notify(`Tools updated`, "info");
        }
        break;
      }
    }
  }
}
```

**Token efficiency:** This entire command costs zero LLM tokens. All interactions are handled through TUI dialogs and runtime configuration APIs.

---

## TUI-Only Commands (Input Interception)

Regular registered commands still show a brief "Working..." spinner and create a message entry. For commands that should feel instant — like toggling a setting — intercept at the `input` event level:

```typescript
// This runs BEFORE message submission — no spinner, no chat entry
pi.on("input", (event, ctx) => {
  const text = event.text.trim();
  if (!text.startsWith("/")) return;

  // Parse command name and arguments (handles "/cmd arg1 arg2")
  const spaceIndex = text.indexOf(" ");
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

  if (commandName === "mystatus") {
    void showStatusUI(ctx); // fire-and-forget async
    return { handled: true }; // prevents message submission entirely
  }
});

// Still register for autocomplete and /help listing
pi.registerCommand("mystatus", {
  description: "Show status dashboard",
  async handler(_args, ctx) { await showStatusUI(ctx); },
});
```

For multiple TUI commands, use a dispatch table (the pattern used in production):

```typescript
const TUI_COMMANDS: Record<string, (pi: ExtensionAPI, ctx: any) => void> = {
  "ext:config": (pi, ctx) => handleConfig(pi, ctx),
  "ext:status": (_pi, ctx) => handleStatus(ctx),
};

pi.on("input", (event, ctx) => {
  const text = event.text.trim();
  if (!text.startsWith("/")) return;
  const cmd = text.indexOf(" ") === -1 ? text.slice(1) : text.slice(1, text.indexOf(" "));
  const handler = TUI_COMMANDS[cmd];
  if (!handler) return;
  handler(pi, ctx);
  return { handled: true };
});
```

**When to use this pattern:**
- Pure UI commands that should feel instant (settings, status, toggles)
- Commands that loop through multiple UI interactions (settings menu)
- Any command where the "Working..." spinner would feel wrong

## Namespacing Commands

Use a prefix to avoid collisions with built-in commands or other extensions:

```typescript
// Good — namespaced
pi.registerCommand("myext:review", { /* ... */ });
pi.registerCommand("myext:config", { /* ... */ });

// Risky — could collide with built-in /status or another extension
pi.registerCommand("status", { /* ... */ });
```

The convention is `extensionname:command`. This is how production extensions like supipowers work (`supi:review`, `supi:config`, `supi:status`).

## The Async Fire-and-Forget Pattern

When an input event handler needs to run async UI code, use the `void (async () => { ... })()` pattern. This is necessary because input handlers must return synchronously:

```typescript
pi.on("input", (event, ctx) => {
  if (event.text.trim() !== "/myconfig") return;

  // void wraps the async IIFE — handler returns { handled: true } synchronously
  // while the async UI loop runs in the background
  void (async () => {
    while (true) {
      const choice = await ctx.ui.select("Settings", ["Theme", "Profile", "Done"]);
      if (!choice || choice === "Done") break;
      // ... handle choices
    }
  })();

  return { handled: true };
});
```

## sendMessage vs sendUserMessage

When triggering the LLM, these have different token-efficiency implications:

| Method | Behavior | Token Efficiency |
|---|---|---|
| `pi.sendMessage({...}, { triggerTurn: true })` | Injects a custom-typed message | Can be filtered from context later via `context` event |
| `pi.sendUserMessage(text)` | Injects as a user message | Persists in context permanently |

**Prefer `sendMessage`** for programmatic prompts — its `customType` lets you filter it out of context on subsequent turns, saving tokens. Use `sendUserMessage` only when the message should genuinely appear as user input.

## Argument Completions

Add tab-completion support for command arguments:

```typescript
pi.registerCommand("deploy", {
  description: "Deploy to environment",
  getArgumentCompletions: (prefix) => {
    const envs = ["staging", "production", "canary"];
    return envs
      .filter(e => e.startsWith(prefix))
      .map(e => ({ label: e, value: e }));
  },
  async handler(args, ctx) {
    // args contains the user's typed arguments
  },
});
```

## Subcommand Pattern

For commands with multiple sub-operations:

```typescript
pi.registerCommand("swarm", {
  description: "Multi-agent swarm orchestration",
  getArgumentCompletions: (prefix) => {
    const subs = ["run", "status", "help"];
    if (!prefix) return subs.map(s => ({ label: s, value: s }));
    return subs.filter(s => s.startsWith(prefix)).map(s => ({ label: s, value: s }));
  },
  async handler(args, ctx) {
    const parts = args.trim().split(/\s+/);
    const sub = parts[0] ?? "help";

    switch (sub) {
      case "run":
        await handleRun(parts.slice(1), ctx);
        return;
      case "status":
        await handleStatus(ctx);
        return;
      default:
        ctx.ui.notify("Usage: /swarm [run|status|help]", "info");
    }
  },
});
```

---

## Choosing the Right Form

| Scenario | Best Form | Why |
|---|---|---|
| Simple prompt template | Markdown | No code needed, but always costs tokens |
| UI → focused LLM prompt | Extension-registered or Standalone TS | Can preprocess and minimize token cost |
| Config/settings panel | Extension-registered + input interception | Zero tokens, instant feel |
| Subcommands with completions | Extension-registered | Full API access, completions support |
| Quick toggle (debug mode, plan mode) | Extension-registered + flag | Can be set via CLI flag OR slash command |

**General rule:** If a markdown command would work, ask yourself — "Could I make this cheaper by gathering context in TypeScript first?" If yes, use a TypeScript command instead.
