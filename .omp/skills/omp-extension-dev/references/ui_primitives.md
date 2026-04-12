# UI Primitives

OMP extensions have access to a rich set of TUI (Terminal User Interface) primitives through `ctx.ui`. These enable interactive dialogs, notifications, status displays, and custom rendering — all without consuming LLM tokens.

## Table of Contents
- [Availability](#availability)
- [Dialog Methods (Round-Trip)](#dialog-methods-round-trip)
- [Fire-and-Forget Methods](#fire-and-forget-methods)
- [Dialog Options](#dialog-options)
- [Custom Message Renderers](#custom-message-renderers)
- [Custom Tool Renderers](#custom-tool-renderers)
- [Complete Example: Interactive Dashboard](#complete-example-interactive-dashboard)

---

## Availability

UI primitives are available through the context object in event handlers, command handlers, and tool execute functions:

```typescript
// In event handlers
pi.on("session_start", async (_event, ctx) => {
  ctx.ui.notify("Hello!", "info");
});

// In command handlers
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    const choice = await ctx.ui.select("Pick one", ["A", "B"]);
  },
});
```

**Always check `ctx.hasUI` before using dialogs** — in headless/SDK mode, dialog methods return `undefined` and fire-and-forget methods silently do nothing:

```typescript
if (ctx.hasUI) {
  const choice = await ctx.ui.select("Pick", options);
} else {
  // Fall back to default behavior — select returns undefined, notify is a no-op
}
```

## Dialog Methods (Round-Trip)

These methods show a dialog and wait for the user's response. They return a Promise that resolves when the user makes a choice.

### `ctx.ui.select(title, options, dialogOptions?)`

Show a selection list. Returns the selected string, or `undefined` if cancelled (Esc).

```typescript
// Simple selection
const env = await ctx.ui.select("Deploy to:", ["staging", "production", "canary"]);
if (!env) return; // user pressed Esc

// With initial selection
const profile = await ctx.ui.select("Review profile", ["quick", "thorough", "full"], {
  initialIndex: 1, // pre-select "thorough"
  helpText: "Select review depth · Esc to cancel",
});

// As a display list (read-only info presented as selectable items)
const items = [
  `Status: ${status}`,
  `Version: ${version}`,
  `Uptime: ${uptime}`,
  "Close",
];
await ctx.ui.select("Dashboard", items, { helpText: "Esc to close" });
```

### `ctx.ui.confirm(title, message, dialogOptions?)`

Show a Yes/No confirmation dialog. Returns `true` or `false`.

```typescript
const ok = await ctx.ui.confirm(
  "Deploy to production?",
  "This will affect all users immediately"
);
if (!ok) {
  ctx.ui.notify("Deploy cancelled", "info");
  return;
}
```

### `ctx.ui.input(title, placeholder?, dialogOptions?)`

Show a text input field. Returns the entered string, or `undefined` if cancelled.

```typescript
const name = await ctx.ui.input("Project name", "my-project");
if (!name) return;

const description = await ctx.ui.input("Description (optional)");
```

### `ctx.ui.onTerminalInput(handler)`

Listen for raw terminal input. Useful for keyboard-driven interactions like games or custom navigation:

```typescript
ctx.ui.onTerminalInput((key) => {
  // key contains the raw terminal input
  if (key === "q") cleanup();
});
```

## Fire-and-Forget Methods

These methods return immediately — they update the display without waiting for user input.

### `ctx.ui.notify(message, type?)`

Show a toast notification. Type controls the visual style.

```typescript
ctx.ui.notify("Extension loaded", "info");       // informational (default)
ctx.ui.notify("Deploy succeeded", "success");    // green success
ctx.ui.notify("Config file missing", "warning"); // yellow warning
ctx.ui.notify("Connection failed", "error");     // red error
// Also available: "summary" for structured summary notifications

// Multi-line notifications
ctx.ui.notify([
  "Deployment Status:",
  "  Environment: staging",
  "  Version: 2.1.0",
  "  Health: OK",
].join("\n"), "info");
```

### `ctx.ui.setStatus(text?)`

Set the footer/status bar text. Pass `undefined` or empty string to clear.

```typescript
ctx.ui.setStatus("Review in progress... (3/10 files)");

// Clear when done
ctx.ui.setStatus();
```

### `ctx.ui.setWidget(key, content?)`

Display a named widget. The `key` identifies the widget so multiple extensions can have simultaneous widgets. Pass `undefined` as content to remove.

```typescript
// Simple string array widget
ctx.ui.setWidget("my-status", [
  "╔══════════════════╗",
  "║ Debug Mode: ON   ║",
  "║ Tools: 5 active  ║",
  "╚══════════════════╝",
]);

// Advanced: factory function for dynamic pi-tui components
ctx.ui.setWidget("my-dashboard", (tui, theme) => {
  // Return a pi-tui Component with render/invalidate/dispose
  return createMyWidget(tui, theme);
});

// Remove widget by key
ctx.ui.setWidget("my-status", undefined);
```

### `ctx.ui.setTitle(title?)`

Set the terminal window title:

```typescript
ctx.ui.setTitle("OMP — my-project (review mode)");
```

### `ctx.ui.setEditorText(text?)`

Pre-fill the user's input editor:

```typescript
ctx.ui.setEditorText("/review --thorough src/");
```

### `ctx.ui.getEditorText()`

Read the current content of the input editor:

```typescript
const currentInput = ctx.ui.getEditorText();
```

### Theme Access

Access the current TUI theme for custom rendering:

```typescript
const theme = ctx.ui.theme;
// theme.fg(color, text) — colorize text
// theme.symbol(key) — get themed symbols (checkmark, arrow, etc.)

ctx.ui.setTheme("monokai"); // switch theme by name
```

## Nested Select Menu Pattern

The most common real-world UI pattern — a loop-based settings menu that drills into sub-selections:

```typescript
async function showSettings(pi: ExtensionAPI, ctx: any) {
  while (true) {
    const choice = await ctx.ui.select("Settings", [
      `Profile: ${currentProfile}`,
      `Model: ${currentModel}`,
      "Done",
    ], { helpText: "Select a setting to change · Esc to close" });

    if (!choice || choice === "Done") break;

    if (choice.startsWith("Profile:")) {
      const profile = await ctx.ui.select("Profile", ["quick", "thorough", "full"]);
      if (profile) {
        currentProfile = profile;
        ctx.ui.notify(`Profile → ${profile}`, "info");
      }
    } else if (choice.startsWith("Model:")) {
      const model = await ctx.ui.select("Model", ["sonnet", "opus", "haiku"]);
      if (model) {
        pi.setModel(model);
        ctx.ui.notify(`Model → ${model}`, "info");
      }
    }
    // Loop continues — user sees updated settings menu
  }
}
```

This pattern is used extensively in production extensions for configuration panels.

## Dialog Options

All dialog methods accept an optional `ExtensionUIDialogOptions` object:

```typescript
interface ExtensionUIDialogOptions {
  signal?: AbortSignal;      // Cancel the dialog programmatically
  timeout?: number;          // Auto-dismiss after N milliseconds
  onTimeout?: () => void;    // Callback when timeout fires
  initialIndex?: number;     // Pre-select index (for select dialogs)
  outline?: boolean;         // Outlined list style
  onLeft?: () => void;       // Left arrow key handler
  onRight?: () => void;      // Right arrow key handler
  helpText?: string;         // Footer hint text
}
```

**Timeout example:**
```typescript
const choice = await ctx.ui.select("Quick pick", ["A", "B", "C"], {
  timeout: 10_000, // 10 seconds
  onTimeout: () => ctx.ui.notify("Selection timed out — using default", "info"),
});
const result = choice ?? "A"; // default if timed out or cancelled
```

**AbortSignal example:**
```typescript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

const choice = await ctx.ui.select("Pick", options, {
  signal: controller.signal,
});
```

## Custom Message Renderers

Register custom TUI rendering for specific message types:

```typescript
pi.registerMessageRenderer("deploy-status", (message, { expanded }, theme) => {
  // message.details contains your custom data
  // expanded: boolean indicating if user expanded this message
  // theme: current TUI theme with color accessors

  // Return a pi-tui Component (from @oh-my-pi/pi-tui)
  // For simple cases, return a string or string array
});
```

Use with `pi.sendMessage()`:
```typescript
pi.sendMessage({
  customType: "deploy-status", // matches the renderer registration
  content: [{ type: "text", text: "Deploying..." }],
  display: "custom",          // use custom renderer
  details: { env: "staging", progress: 45 },
});
```

## Custom Tool Renderers

Override how tool calls and results are displayed in the chat:

```typescript
pi.registerTool({
  name: "my_tool",
  // ...other fields...

  renderCall(args, theme) {
    // How the tool invocation looks in the TUI
    // args: the parameters passed to the tool
    // Return a pi-tui Component
  },

  renderResult(result, options, theme, args) {
    // How the tool result looks in the TUI
    // result.details: your persisted data
    // options.expanded: whether the user expanded this result
    // Return a pi-tui Component
  },
});
```

---

## Complete Example: Interactive Dashboard

A full extension demonstrating multiple UI primitives working together:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function dashboardExtension(pi: ExtensionAPI) {
  pi.setLabel("Project Dashboard");

  let taskCount = 0;
  let lastDeploy: string | null = null;

  // TUI-only command — instant, no spinner
  pi.on("input", (event, ctx) => {
    if (event.text.trim() === "/dashboard") {
      void showDashboard(pi, ctx);
      return { handled: true };
    }
  });

  pi.registerCommand("dashboard", {
    description: "Interactive project dashboard",
    async handler(_args, ctx) {
      await showDashboard(pi, ctx);
    },
  });

  // Update status line with live info
  pi.on("agent_end", async (_event, ctx) => {
    taskCount++;
    ctx.ui.setStatus(`Tasks completed: ${taskCount}`);
  });
}

async function showDashboard(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.hasUI) {
    ctx.ui.notify("Dashboard requires interactive mode", "warning");
    return;
  }

  while (true) {
    // Gather data deterministically (no LLM)
    const gitResult = await pi.exec("git", ["log", "--oneline", "-5"], { cwd: ctx.cwd });
    const recentCommits = gitResult.stdout.split("\n").filter(Boolean);

    const branchResult = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.cwd });
    const branch = branchResult.stdout.trim();

    const statusResult = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
    const changedFiles = statusResult.stdout.split("\n").filter(Boolean).length;

    // Build display
    const items = [
      `Branch: ${branch}`,
      `Changed files: ${changedFiles}`,
      `Recent commits: ${recentCommits.length}`,
      ...recentCommits.map(c => `  ${c}`),
      "---",
      "Actions:",
      "  View diff",
      "  Refresh",
      "  Close",
    ];

    const choice = await ctx.ui.select("Project Dashboard", items, {
      helpText: "Select an action · Esc to close",
    });

    if (!choice || choice.includes("Close")) break;

    if (choice.includes("View diff")) {
      const diff = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd });
      ctx.ui.notify(diff.stdout || "No changes", "info");
    } else if (choice.includes("Refresh")) {
      continue; // loop re-fetches data
    }
  }
}
```

**Token efficiency:** This entire dashboard — data gathering, display, interaction loop — costs zero LLM tokens. Everything is handled through `pi.exec()` and UI primitives.
