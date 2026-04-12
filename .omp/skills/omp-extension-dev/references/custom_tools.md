# Custom Tools

Custom tools are functions the LLM can invoke during its reasoning. They appear in the model's tool list alongside built-in tools like `read`, `edit`, `bash`, etc. Use them when you want the LLM to be able to perform a specific operation with structured parameters.

## Table of Contents
- [When to Use Custom Tools vs Slash Commands](#when-to-use-custom-tools-vs-slash-commands)
- [Registering Tools via Extension API](#registering-tools-via-extension-api)
- [Standalone Custom Tool (CustomToolFactory)](#standalone-custom-tool-customtoolfactory)
- [Parameter Schemas with TypeBox](#parameter-schemas-with-typebox)
- [The Execute Function](#the-execute-function)
- [Streaming Updates](#streaming-updates)
- [State Management](#state-management)
- [Custom TUI Rendering](#custom-tui-rendering)
- [Discovery Locations](#discovery-locations)
- [Complete Example: Project Stats Tool](#complete-example-project-stats-tool)

---

## When to Use Custom Tools vs Slash Commands

| Use a **Custom Tool** when... | Use a **Slash Command** when... |
|---|---|
| The LLM should decide when to call it | The user explicitly triggers it |
| It needs structured input parameters | It needs interactive UI (select, confirm) |
| It returns data for the LLM to reason about | It performs a side effect (config change, deploy) |
| It's part of the LLM's reasoning loop | It's a workflow entry point |

**Token efficiency note:** Every tool call consumes tokens (the LLM generates the call, reads the result). If the operation is always triggered by the user, make it a slash command instead — it can use `pi.exec()` directly without LLM overhead.

## Registering Tools via Extension API

Inside an extension factory, use `pi.registerTool()`:

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const { Type } = pi.typebox;

  pi.registerTool({
    name: "search_jira",
    label: "Search Jira",
    description: "Search Jira issues by JQL query",
    parameters: Type.Object({
      jql: Type.String({ description: "JQL query string" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results to return", default: 10 })),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      const { jql, maxResults } = params as { jql: string; maxResults?: number };

      // Do the work — fetch from Jira API, read from cache, etc.
      const issues = await fetchJiraIssues(jql, maxResults ?? 10);

      return {
        content: [{ type: "text", text: JSON.stringify(issues, null, 2) }],
        details: { count: issues.length, jql },
      };
    },
  });
}
```

## Standalone Custom Tool (CustomToolFactory)

For tools that don't need the full extension lifecycle, create a standalone module:

```typescript
// ~/.omp/agent/tools/repo-stats/index.ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Count tracked files by type in the git repository",
  parameters: pi.typebox.Type.Object({
    extension: pi.typebox.Type.Optional(
      pi.typebox.Type.String({ description: "File extension to filter (e.g., '.ts')", default: ".ts" })
    ),
  }),
  async execute(toolCallId, params, onUpdate, ctx, signal) {
    const ext = (params as any).extension ?? ".ts";
    const result = await pi.exec("git", ["ls-files", "--", `*${ext}`], { cwd: pi.cwd });
    const files = result.stdout.split("\n").filter(Boolean);

    return {
      content: [{ type: "text", text: `Found ${files.length} ${ext} files in the repository.` }],
      details: { count: files.length, extension: ext },
    };
  },
});

export default factory;
```

**CustomToolAPI** (the `pi` parameter for standalone tools):

| Property/Method | Purpose |
|---|---|
| `pi.typebox` | `@sinclair/typebox` for parameter schemas |
| `pi.pi` | `@oh-my-pi/pi-coding-agent` exports |
| `pi.logger` | Shared file logger |
| `pi.exec(cmd, args, opts?)` | Process execution helper |
| `pi.cwd` | Host working directory |
| `pi.ui` | UI context (may be no-op in headless mode) |
| `pi.hasUI` | `false` in non-interactive/SDK flows |

## Parameter Schemas with TypeBox

OMP uses `@sinclair/typebox` for parameter schemas. Access it via `pi.typebox.Type`:

```typescript
const { Type } = pi.typebox;

// Basic types
Type.String({ description: "A name" })
Type.Number({ description: "Count", minimum: 0 })
Type.Boolean({ description: "Enable verbose output" })

// Optional parameters
Type.Optional(Type.String({ default: "hello" }))

// Enums (use StringEnum from pi.pi for string enums)
const { StringEnum } = pi.pi;
StringEnum(["staging", "production"], { description: "Target environment" })

// Nested objects
Type.Object({
  query: Type.String(),
  options: Type.Optional(Type.Object({
    limit: Type.Number({ default: 10 }),
    verbose: Type.Boolean({ default: false }),
  })),
})

// Arrays
Type.Array(Type.String(), { description: "List of file paths" })
```

## The Execute Function

```typescript
async execute(
  toolCallId: string,       // unique ID for this tool invocation
  params: unknown,          // parsed parameters (cast to your type)
  onUpdate: UpdateFn,       // streaming updates callback
  ctx: ToolExecuteContext,  // session and model context
  signal?: AbortSignal,     // cancellation signal
) {
  // Return shape:
  return {
    content: [{ type: "text", text: "result" }],  // what the LLM sees
    details: { /* any data */ },                    // persisted in session, used for state reconstruction
    isError?: boolean,                              // if true, LLM treats as error
  };
}
```

**`isError` vs throwing:** Use `isError: true` when you want to return a structured error the LLM can reason about and retry (e.g., "file not found, try a different path"). Throwing an exception propagates as an unhandled failure that may abort the tool pipeline — only throw for truly unexpected errors.

**Context (`ctx`):**

| Property | Purpose |
|---|---|
| `ctx.sessionManager` | Access session entries, branch history |
| `ctx.model` | Current model info |
| `ctx.cwd` | Working directory |

**Important:** The `execute` context does NOT include `ctx.ui`. If your tool needs user interaction during execution, use the factory-level `pi.ui` (available on `CustomToolAPI`), not `ctx`. Check `pi.hasUI` first — it is `false` in headless/SDK mode.

**Cancellation:** Always check `signal?.aborted` for long-running operations:

```typescript
async execute(toolCallId, params, onUpdate, ctx, signal) {
  for (const file of files) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled by user" }] };
    }
    await processFile(file);
  }
  // ...
}
```

## Streaming Updates

Use `onUpdate` to stream partial results back to the TUI while the tool is running:

```typescript
async execute(toolCallId, params, onUpdate, ctx, signal) {
  onUpdate?.({
    content: [{ type: "text", text: "Scanning files..." }],
    details: { phase: "scan" },
  });

  const files = await scanFiles();

  onUpdate?.({
    content: [{ type: "text", text: `Found ${files.length} files. Analyzing...` }],
    details: { phase: "analyze", fileCount: files.length },
  });

  const results = await analyzeFiles(files);

  return {
    content: [{ type: "text", text: formatResults(results) }],
    details: { phase: "complete", results },
  };
}
```

## State Management

Tools can persist state across session events (branching, switching, tree navigation) using the `details` field and the `onSession` callback. This is the pattern used by the official Todo tool:

```typescript
const factory: CustomToolFactory = (pi) => {
  let todos: Map<number, Todo> = new Map();
  let nextId = 1;

  return {
    name: "todo",
    // ... parameters, description

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      // Modify state
      todos.set(nextId, { id: nextId, text: params.text, done: false });
      nextId++;

      // Persist state in details — this is saved in session history
      return {
        content: [{ type: "text", text: `Added todo #${nextId - 1}` }],
        details: { todos: Object.fromEntries(todos), nextId },
      };
    },

    // Reconstruct state when session changes
    // event.reason: "start" | "switch" | "branch" | "tree" | "shutdown"
    onSession(event, ctx) {
      todos.clear();
      nextId = 1;

      // Walk branch history and rebuild state from tool result details
      for (const entry of ctx.sessionManager.getBranch()) {
        if (
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "todo"
        ) {
          const details = entry.message.details;
          if (details) {
            todos = new Map(Object.entries(details.todos).map(([k, v]) => [Number(k), v as Todo]));
            nextId = details.nextId;
          }
        }
      }
    },
  };
};
```

This pattern ensures state is always consistent with the current branch point — if the user branches from an earlier point, the tool state rolls back correctly.

## Custom TUI Rendering

Override how tool calls and results appear in the terminal:

```typescript
pi.registerTool({
  name: "my_tool",
  // ...

  // Custom rendering for tool invocation
  renderCall(args, theme) {
    // Return a pi-tui Component
    // theme provides colors: theme.primary, theme.secondary, etc.
  },

  // Custom rendering for tool result
  renderResult(result, options, theme, args) {
    // result.details contains your persisted data
    // options.expanded indicates if the user expanded this entry
  },
});
```

## Discovery Locations

Standalone tools (not registered via extensions) are auto-discovered from:

| Location | Scope |
|---|---|
| `~/.omp/agent/tools/*/index.ts` | User-level (global) |
| `<cwd>/.omp/tools/*/index.ts` | Project-level |
| `~/.claude/tools/*/` | Claude Code compatibility |
| `~/.codex/tools/*/` | Codex compatibility |
| `~/.omp/plugins/node_modules/*` | Installed plugins |

You can also specify tools explicitly via `--tool <path>` or in settings.

---

## Complete Example: Project Stats Tool

A standalone tool that analyzes the project structure:

```typescript
// ~/.omp/agent/tools/project-stats/index.ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "project_stats",
  label: "Project Stats",
  description: "Analyze project structure: file counts by type, total lines, and recent git activity",
  parameters: pi.typebox.Type.Object({
    includeGitStats: pi.typebox.Type.Optional(
      pi.typebox.Type.Boolean({ description: "Include git commit stats", default: true })
    ),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    const { includeGitStats } = params as { includeGitStats?: boolean };

    onUpdate?.({
      content: [{ type: "text", text: "Counting files..." }],
      details: { phase: "files" },
    });

    // Count files by extension
    const filesResult = await pi.exec("git", ["ls-files"], { cwd: pi.cwd });
    const files = filesResult.stdout.split("\n").filter(Boolean);
    const byExt: Record<string, number> = {};
    for (const f of files) {
      const ext = f.includes(".") ? `.${f.split(".").pop()}` : "(no ext)";
      byExt[ext] = (byExt[ext] ?? 0) + 1;
    }

    let gitInfo = "";
    if (includeGitStats !== false) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

      onUpdate?.({
        content: [{ type: "text", text: "Fetching git stats..." }],
        details: { phase: "git" },
      });

      const logResult = await pi.exec(
        "git", ["log", "--oneline", "--since=7 days ago"],
        { cwd: pi.cwd },
      );
      const recentCommits = logResult.stdout.split("\n").filter(Boolean).length;
      gitInfo = `\nRecent commits (7 days): ${recentCommits}`;
    }

    const sorted = Object.entries(byExt).sort((a, b) => b[1] - a[1]);
    const summary = [
      `Total tracked files: ${files.length}`,
      "",
      "By extension:",
      ...sorted.slice(0, 15).map(([ext, count]) => `  ${ext}: ${count}`),
      sorted.length > 15 ? `  ... and ${sorted.length - 15} more types` : "",
      gitInfo,
    ].join("\n");

    return {
      content: [{ type: "text", text: summary }],
      details: { totalFiles: files.length, byExtension: byExt },
    };
  },
});

export default factory;
```
