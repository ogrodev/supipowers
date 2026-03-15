# Context Mode Integration — Design Spec

## Overview

Integrate context-mode capabilities into supipowers to reduce context window bloat during sub-agent runs and main session operation. The integration uses a hybrid approach: native result compression via OMP's `tool_result` hook as the primary mechanism, with routing instructions injected via `before_agent_start` as a secondary signal when context-mode MCP tools are available.

## Problem

Sub-agents dispatched by `/supi:run` make heavy tool calls (Bash, Read, Grep, Find) that produce large raw outputs. These outputs consume the sub-agent's context window, limiting how much work a sub-agent can accomplish before hitting context limits. The same problem affects the main session during interactive use.

## Core Principles

- **Native-first**: Result compression works without context-mode installed. No external dependencies required for the primary mechanism.
- **Opportunistic enhancement**: When context-mode MCP tools are detected, inject routing instructions as a secondary signal. The model may prefer sandbox tools proactively, reducing the number of results that need interception.
- **Fail-safe**: Compression errors fall through to raw output. Detection failures default to "not available." Never degrade the agent's ability to do work.
- **Configurable**: Users can tune compression thresholds and toggle features via the existing three-layer config system.

## Architecture

Three layers, each independently toggleable:

```
Layer 1: Result Compression (tool_result hook)
    Tool executes normally → output > threshold? → structural summarization → compressed content returned to LLM

Layer 2: Command Blocking (tool_call hook)
    curl/wget/HTTP detected? → block with reason → LLM redirected to ctx_fetch_and_index (if available)

Layer 3: Routing Instructions (before_agent_start hook)
    ctx_* tools detected? → append routing skill to system prompt → model prefers sandbox tools proactively
```

All three are registered from `src/index.ts` during extension setup. Layer 1 works standalone. Layers 2 and 3 activate only when context-mode MCP tools are detected.

## Components

### `src/context-mode/detector.ts`

Checks `pi.getActiveTools()` for context-mode MCP tool names. Returns a typed status object.

```typescript
/** Which context-mode MCP tools are available in the current session */
export interface ContextModeStatus {
  available: boolean;
  tools: {
    ctxExecute: boolean;
    ctxBatchExecute: boolean;
    ctxExecuteFile: boolean;
    ctxIndex: boolean;
    ctxSearch: boolean;
    ctxFetchAndIndex: boolean;
  };
}

/** Detect context-mode MCP tool availability from the active tools list */
export function detectContextMode(activeTools: string[]): ContextModeStatus;
```

Called once at `session_start`, result cached in module scope. Follows the existing `src/lsp/detector.ts` pattern.

### `src/context-mode/compressor.ts`

Pure functions that take tool result content and produce compressed versions. One function per tool type, plus a dispatcher.

**General rules (applied before any tool-specific logic):**

- If `event.isError === true`, pass through unmodified regardless of tool type. Error messages are critical for self-correction and must not be truncated.
- If `event.content` contains any `ImageContent` entries, pass through unmodified. Compression is text-only; silently dropping images would lose information.
- Threshold is measured against the total byte length of all `TextContent` entries in `event.content`. `ImageContent` entries are excluded from the byte count.

**Compression strategies by tool type:**

- **Bash**: Keep exit code. If error (non-zero exit), keep the full stderr block. Otherwise keep the first 5 lines (command echo / headers) and last 10 lines (tail), with a `[...compressed: N lines omitted...]` marker. Total line count included.
- **Read**: If the read used `offset`/`limit` (already scoped), pass through unmodified. Otherwise keep file path, total line count, and the first 10 lines as a structure preview.
- **Grep**: Keep total match count and first 10 matches with their context lines. Drop the rest.
- **Find**: Keep total file count and first 20 paths. Drop the rest.

**Threshold**: Configurable via `config.contextMode.compressionThreshold`, default 4096 bytes. Results below threshold pass through unmodified.

**Output shape**: When compression applies, the returned `content` array contains a single compressed `TextContent` entry. Since compression only activates for text-only results (ImageContent triggers passthrough), no image preservation logic is needed.

```typescript
/** Compress a tool result if it exceeds the threshold */
export function compressToolResult(
  event: ToolResultEvent,
  threshold: number,
): ToolResultEventResult | undefined;
```

Returns `undefined` (no modification) when: output is below threshold, tool type is unrecognized, `event.isError` is true, or content contains `ImageContent`.

### `src/context-mode/hooks.ts`

Registers OMP event handlers. Single function called from `src/index.ts`.

```typescript
/** Register context-mode hooks on the extension API */
export function registerContextModeHooks(pi: ExtensionAPI, config: SupipowersConfig): void;
```

Registers three handlers:

1. **`tool_result`** — Calls `compressToolResult()` when `config.contextMode.enabled` is true. Returns the compressed content or `undefined` to pass through.

2. **`tool_call`** — When `config.contextMode.blockHttpCommands` is true and context-mode is detected: checks if the bash command matches curl/wget/HTTP fetch patterns. If so, returns `{ block: true, reason }` with a message directing the model to use `ctx_fetch_and_index`. If context-mode is not detected, does not block (the model has no alternative).

3. **`before_agent_start`** — When `config.contextMode.routingInstructions` is true and context-mode is detected: loads `skills/context-mode/SKILL.md` and returns `{ systemPrompt }` with the **existing system prompt concatenated with routing instructions**. The handler reads `event.systemPrompt` (the current system prompt for this turn), appends the routing content after a separator, and returns the combined string. This preserves the base system prompt while adding routing guidance. OMP chains multiple extensions' `systemPrompt` returns, so this is safe to use alongside other extensions.

### `skills/context-mode/SKILL.md`

Routing instructions loaded by the `before_agent_start` handler when context-mode is detected. Adapted from context-mode's ROUTING_BLOCK, tuned for OMP tool names.

The skill file contains concrete routing directives, not topic outlines. Key sections:

1. **Tool hierarchy** — explicit preference order with examples:
   - `ctx_batch_execute` for multi-step operations (multiple commands + grep in one call)
   - `ctx_search` for querying previously indexed knowledge (no re-execution needed)
   - `ctx_execute` / `ctx_execute_file` for single commands or file processing
   - Raw Bash/Read/Grep only when editing files (Read before Edit) or running build/test commands where real-time output matters

2. **Forbidden patterns** — explicit prohibitions:
   - Do not use Bash for `curl`/`wget`/HTTP requests — use `ctx_fetch_and_index`
   - Do not use Read for large-file analysis — use `ctx_execute_file` to process and summarize
   - Do not use Bash for directory listing > 20 files — use `ctx_execute`

3. **Output constraints** — keep responses under 500 words, write large artifacts to files rather than inline

4. **Sub-agent awareness** — these instructions apply within sub-agent sessions; sub-agents should follow the same tool preference hierarchy

### `src/orchestrator/dispatcher.ts` (modification)

Small addition to `dispatchAgent()`: before calling `buildTaskPrompt()`, call `detectContextMode(pi.getActiveTools())`. Pass the resulting `contextModeAvailable: boolean` to `buildTaskPrompt()` alongside the existing `lspAvailable` flag.

Redundant with Layer 3 by design — duplicate instructions are harmless, but a missed injection is a missed compression opportunity.

### `src/orchestrator/prompts.ts` (modification)

`buildTaskPrompt()` gains a new parameter `contextModeAvailable: boolean`. When true, it appends a context-mode routing section to the prompt, structured identically to the existing LSP conditional block:

```typescript
export function buildTaskPrompt(
  task: PlanTask,
  planContext: string,
  config: SupipowersConfig,
  lspAvailable: boolean,
  contextModeAvailable: boolean,  // new parameter
  workDir?: string,
): string {
  // ... existing prompt building ...

  if (contextModeAvailable) {
    // Append routing section (same pattern as LSP block)
    // Load and inline the routing instructions from skills/context-mode/SKILL.md
  }

  // ...
}
```

`buildFixPrompt()` and `buildMergePrompt()` also gain the `contextModeAvailable` parameter and append the same routing section when true.

### `src/orchestrator/conflict-resolver.ts` (modification)

`analyzeConflicts()` gains access to the `contextModeAvailable` flag (passed through from the orchestrator) and forwards it to `buildMergePrompt()`. This is a mechanical plumbing change — add the parameter to the function signature and the call site.

### `src/types.ts` (modification)

Add `contextMode` to `SupipowersConfig`:

```typescript
export interface ContextModeConfig {
  /** Master toggle for context-mode integration */
  enabled: boolean;
  /** Byte threshold above which tool results are compressed (default: 4096) */
  compressionThreshold: number;
  /** Block curl/wget/HTTP commands and redirect to ctx_fetch_and_index */
  blockHttpCommands: boolean;
  /** Inject routing instructions into system prompt when ctx_* tools detected */
  routingInstructions: boolean;
}
```

Added as `contextMode: ContextModeConfig` to `SupipowersConfig`.

### `src/config/defaults.ts` (modification)

Add defaults for the new config section:

```typescript
contextMode: {
  enabled: true,
  compressionThreshold: 4096,
  blockHttpCommands: true,
  routingInstructions: true,
}
```

## Data Flow

### Result Compression (Layer 1)

```
Agent calls Bash("ls -la /project/src") → tool executes normally
    │
    ▼
tool_result fires with 200-line output (12KB)
    │
    ├── config.contextMode.enabled? No → pass through
    │
    ├── output < 4096 bytes? → pass through
    │
    └── output ≥ 4096 bytes
         │
         ▼
    compressBashResult(event)
         │
         ├── Non-zero exit code? → keep full stderr
         │
         └── Success → first 5 lines + "[...compressed: 185 lines omitted...]" + last 10 lines
              │
              ▼
         Return { content: [{ type: "text", text: compressed }] }
              │
              ▼
         LLM sees ~20 lines instead of 200
```

### Command Blocking (Layer 2)

```
Agent calls Bash("curl https://api.example.com/large-response")
    │
    ▼
tool_call fires
    │
    ├── config.contextMode.blockHttpCommands? No → pass through
    │
    ├── context-mode detected? No → pass through (no alternative available)
    │
    └── curl/wget pattern matched + ctx_fetch_and_index available
         │
         ▼
    Return { block: true, reason: "Use ctx_fetch_and_index('https://api.example.com/large-response') instead. It fetches, indexes, and returns a compressed summary." }
         │
         ▼
    LLM receives the block reason and retries with ctx_fetch_and_index
```

### Routing Instructions (Layer 3)

```
User submits prompt → before_agent_start fires
    │
    ├── config.contextMode.routingInstructions? No → no-op
    │
    ├── context-mode detected? No → no-op
    │
    └── ctx_* tools available
         │
         ▼
    Load skills/context-mode/SKILL.md
         │
         ▼
    Return { systemPrompt: event.systemPrompt + "\n\n" + routingInstructions }
         │
         ▼
    System prompt for this turn includes routing guidance
```

## Error Handling

- **Compressor errors**: Caught and logged via `pi.logger.warn()`. Original content returned unmodified. A compression failure never breaks a tool call.
- **Detector errors**: Default to `{ available: false }`. Conservative — no routing, no blocking, compression still works standalone.
- **Skill loading errors**: Logged, routing instructions skipped for that turn. Layer 1 (compression) still operates.
- **Config loading errors**: Fall through to defaults (compression on, 4KB threshold, blocking and routing on).

## Testing

### `tests/context-mode/detector.test.ts`

- Returns `available: true` when all ctx_* tools present
- Returns `available: false` when none present
- Partial availability (some tools present, some not) — individual flags correct
- Empty tools list → not available

### `tests/context-mode/compressor.test.ts`

Per tool type:
- Below threshold → returns `undefined` (no modification)
- Above threshold → returns compressed content with correct structure
- **Bash**: exit code preserved, error output kept in full, success output truncated with marker
- **Bash**: first/last line counts are correct
- **Read**: scoped reads (with offset/limit) pass through unmodified
- **Read**: full file reads compressed to preview
- **Grep**: match count correct, first N matches preserved
- **Find**: file count correct, first N paths preserved
- Edge cases: empty output, single-line output, output exactly at threshold
- `isError: true` results pass through unmodified regardless of size
- Results with ImageContent pass through unmodified (returns `undefined`)
- Mixed content (TextContent + ImageContent) passes through unmodified (returns `undefined`)

### `tests/context-mode/hooks.test.ts`

- Hooks registered when config.contextMode.enabled is true
- Hooks not registered when config.contextMode.enabled is false
- tool_result handler calls compressor and returns result
- tool_result handler passes through when compressor returns undefined
- tool_call handler blocks curl commands when context-mode detected
- tool_call handler passes through curl when context-mode not detected
- before_agent_start handler concatenates routing to event.systemPrompt when context-mode detected
- before_agent_start handler is no-op when context-mode not detected

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/context-mode/detector.ts` | Create | Context-mode MCP tool detection |
| `src/context-mode/compressor.ts` | Create | Structural summarization per tool type |
| `src/context-mode/hooks.ts` | Create | OMP event handler registration |
| `skills/context-mode/SKILL.md` | Create | Routing instructions for system prompt injection |
| `src/types.ts` | Modify | Add `ContextModeConfig` type and `contextMode` field to `SupipowersConfig` |
| `src/config/defaults.ts` | Modify | Add default values for `contextMode` config |
| `src/config/schema.ts` | Modify | Add TypeBox schema for `contextMode` config section |
| `src/index.ts` | Modify | Call `registerContextModeHooks()` during extension setup |
| `src/orchestrator/dispatcher.ts` | Modify | Inject routing instructions into sub-agent prompts when ctx_* detected |
| `src/orchestrator/prompts.ts` | Modify | Add `contextModeAvailable` parameter to prompt builders, append routing section when true |
| `src/orchestrator/conflict-resolver.ts` | Modify | Forward `contextModeAvailable` flag to `buildMergePrompt()` |
| `tests/context-mode/detector.test.ts` | Create | Detector unit tests |
| `tests/context-mode/compressor.test.ts` | Create | Compressor unit tests per tool type |
| `tests/context-mode/hooks.test.ts` | Create | Hook registration integration tests |

## Out of Scope

- **Session continuity**: Context-mode's SQLite event tracking and BM25 search for session resumption. Separate concern, separate spec.
- **LLM-powered summarization**: Using a model call to compress results. Adds latency and cost. Structural summarization is sufficient for v1.
- **Context-mode installation management**: Supipowers does not install, start, or manage the context-mode MCP server. It detects its tools opportunistically.
- **Compaction hooks**: `session_before_compact` and `session.compacting` integration. Valuable but orthogonal to context bloat during active tool use.
