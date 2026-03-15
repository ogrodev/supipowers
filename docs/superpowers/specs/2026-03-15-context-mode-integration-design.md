# Context Mode Integration — Design Spec

## Overview

Full integration of context-mode capabilities into supipowers: native result compression, tool routing, event tracking, compaction-aware session continuity, LLM-powered summarization, and context-mode installation management. Implemented in five phases, each independently valuable and shippable.

## Problem

Sub-agents dispatched by `/supi:run` make heavy tool calls (Bash, Read, Grep, Find) that produce large raw outputs. These outputs consume the sub-agent's context window, limiting how much work a sub-agent can accomplish before hitting context limits. The same problem affects the main session during interactive use. When OMP auto-compacts the session, the agent loses track of what it was doing — decisions, file state, pending tasks, and error context are lost or poorly summarized.

## Core Principles

- **Native-first**: Core features (compression, event tracking, compaction) work without context-mode installed. No external dependencies for the primary mechanisms.
- **Opportunistic enhancement**: When context-mode MCP tools are detected, inject routing instructions and leverage its sandbox tools. The model may prefer sandbox tools proactively, reducing the number of results that need interception.
- **Fail-safe**: Compression errors fall through to raw output. Event store errors are logged but never block tool execution. Detection failures default to "not available." Never degrade the agent's ability to do work.
- **Configurable**: Users can tune thresholds and toggle each feature via the existing three-layer config system.
- **Phased delivery**: Each phase is independently valuable. Phase 1 (compression + routing) works alone. Phase 2 (events) enables Phase 3 (compaction). Phase 4 (LLM summarization) enhances Phase 1. Phase 5 (installation) is pure convenience.

## Architecture

Five phases, each building on the previous:

```
Phase 1: Result Compression + Command Blocking + Routing (tool_result, tool_call, before_agent_start)
    Native result compression, HTTP blocking, routing instructions when ctx_* detected

Phase 2: Event Tracking (tool_result, before_agent_start, session_start)
    Extract structured events from tool results → store in SQLite

Phase 3: Compaction Integration (session_before_compact, session.compacting)
    Build resume snapshot from events → inject into compaction summary

Phase 4: LLM Summarization (tool_result — async enhancement)
    Optional model call for high-quality compression of very large outputs

Phase 5: Installation Management (/supi:config addition)
    Detect, install, and configure context-mode MCP server
```

All hooks are registered from `src/index.ts` via `registerContextModeHooks()`. The master toggle `config.contextMode.enabled` gates all registration.

---

## Phase 1: Result Compression + Command Blocking + Routing

### Components

#### `src/context-mode/detector.ts`

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

#### `src/context-mode/compressor.ts`

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

#### `src/context-mode/hooks.ts`

Registers OMP event handlers. Single function called from `src/index.ts`.

```typescript
/** Register context-mode hooks on the extension API */
export function registerContextModeHooks(pi: ExtensionAPI, config: SupipowersConfig): void;
```

If `config.contextMode.enabled` is false, no handlers are registered (true master toggle). When enabled, registers three handlers, each with its own sub-toggle:

1. **`tool_result`** — Calls `compressToolResult()`. Returns the compressed content or `undefined` to pass through. (Also calls event extraction in Phase 2.)

2. **`tool_call`** — When `config.contextMode.blockHttpCommands` is true and context-mode is detected: checks if the bash command matches curl/wget/HTTP fetch patterns. If so, returns `{ block: true, reason }` with a message directing the model to use `ctx_fetch_and_index`. If context-mode is not detected, does not block (the model has no alternative).

3. **`before_agent_start`** — When `config.contextMode.routingInstructions` is true and context-mode is detected: loads `skills/context-mode/SKILL.md` and returns `{ systemPrompt }` with the **existing system prompt concatenated with routing instructions**. The handler reads `event.systemPrompt` (the current system prompt for this turn), appends the routing content after a separator, and returns the combined string. This preserves the base system prompt while adding routing guidance. OMP chains multiple extensions' `systemPrompt` returns, so this is safe to use alongside other extensions.

#### `skills/context-mode/SKILL.md`

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

#### `src/orchestrator/dispatcher.ts` (modification)

Small addition to `dispatchAgent()`: before calling `buildTaskPrompt()`, call `detectContextMode(pi.getActiveTools())`. Pass the resulting `contextModeAvailable: boolean` to `buildTaskPrompt()` alongside the existing `lspAvailable` flag.

Redundant with Layer 3 by design — duplicate instructions are harmless, but a missed injection is a missed compression opportunity.

#### `src/orchestrator/prompts.ts` (modification)

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

#### `src/orchestrator/conflict-resolver.ts` (modification)

`analyzeConflicts()` gains access to the `contextModeAvailable` flag (passed through from the orchestrator) and forwards it to `buildMergePrompt()`. This is a mechanical plumbing change — add the parameter to the function signature and the call site.

### Phase 1 Data Flow

**Result Compression:**

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

**Command Blocking:**

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
    Return { block: true, reason: "Use ctx_fetch_and_index('https://...') instead." }
```

**Routing Instructions:**

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
    Return { systemPrompt: event.systemPrompt + "\n\n" + routingInstructions }
```

---

## Phase 2: Event Tracking

### Purpose

Track structured events from every tool call — file operations, git state, errors, task updates, cwd changes — in a local SQLite database. This data feeds Phase 3 (compaction) and provides session history for debugging and resumption.

### Components

#### `src/context-mode/event-store.ts`

SQLite database at `.omp/supipowers/sessions/events.db` using `bun:sqlite`. Manages schema creation, event writes, and queries.

```typescript
/** Event categories extracted from tool results */
export type EventCategory =
  | "file"        // file read/write/edit with path
  | "git"         // commit, branch, status change
  | "error"       // tool failure, non-zero exit
  | "task"        // task create/update (from TodoWrite)
  | "cwd"         // working directory change
  | "mcp"         // MCP tool usage
  | "subagent"    // sub-agent dispatch
  | "prompt"      // user prompt captured
  | "decision";   // user decision or intent

/** Priority levels for resume snapshot ordering */
export type EventPriority = "critical" | "high" | "medium" | "low";

/** A tracked event */
export interface TrackedEvent {
  id?: number;
  sessionId: string;
  category: EventCategory;
  data: string;          // JSON-serialized event payload
  priority: EventPriority;
  source: string;        // which hook produced it (e.g., "tool_result", "before_agent_start")
  timestamp: number;
}

export class EventStore {
  constructor(dbPath: string);

  /** Initialize database schema (creates tables + FTS5 index if not exists) */
  init(): void;

  /** Write a single event. Must complete in <5ms — no blocking. */
  writeEvent(event: Omit<TrackedEvent, "id">): void;

  /** Write multiple events in a single transaction */
  writeEvents(events: Omit<TrackedEvent, "id">[]): void;

  /** Query events by session, optionally filtered by category and/or priority */
  getEvents(sessionId: string, filters?: {
    categories?: EventCategory[];
    priority?: EventPriority;
    since?: number;
    limit?: number;
  }): TrackedEvent[];

  /** Full-text search across event data */
  searchEvents(sessionId: string, query: string, limit?: number): TrackedEvent[];

  /** Get event count by category for a session */
  getEventCounts(sessionId: string): Record<EventCategory, number>;

  /** Delete events older than a timestamp */
  pruneEvents(olderThan: number): number;

  /** Close the database connection */
  close(): void;
}
```

**Schema (SQLite):**

```sql
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  category TEXT NOT NULL,
  data TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_category ON session_events(session_id, category);

-- FTS5 virtual table for full-text search across event data
CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
  data,
  content=session_events,
  content_rowid=id
);
```

The FTS5 table is kept in sync via SQLite triggers on INSERT/DELETE.

#### `src/context-mode/event-extractor.ts`

Pure functions that parse typed `ToolResultEvent` details into `TrackedEvent` objects. One function per tool type.

```typescript
/** Extract events from a tool result */
export function extractEvents(
  event: ToolResultEvent,
  sessionId: string,
): Omit<TrackedEvent, "id">[];
```

**Extraction rules by tool type:**

- **Bash** (`BashToolDetails`): Extract command executed, exit code. If the command is a git operation, emit a `"git"` event. If exit code is non-zero, emit an `"error"` event with the stderr. If the command contains `cd`, emit a `"cwd"` event.
- **Read** (`ReadToolDetails`): Emit a `"file"` event with `{ op: "read", path, lines }`.
- **Edit** (`EditToolDetails`): Emit a `"file"` event with `{ op: "edit", path, changes }`.
- **Write** (`WriteToolDetails` — undefined details): Emit a `"file"` event with `{ op: "write", path }` extracted from `event.input`.
- **Grep** (`GrepToolDetails`): Emit a `"file"` event with `{ op: "search", matchCount }`.
- **Find** (`FindToolDetails`): Emit a `"file"` event with `{ op: "find", fileCount }`.

**Priority assignment:**

| Category | Default Priority | Elevated When |
|----------|-----------------|---------------|
| error    | critical        | always        |
| git      | high            | commits, branch changes |
| task     | high            | always        |
| file     | medium          | writes/edits → high |
| cwd      | low             | always        |
| mcp      | low             | always        |
| prompt   | high            | always        |
| decision | high            | always        |

#### `src/context-mode/hooks.ts` (extension)

The `tool_result` handler gains event extraction: after compression, call `extractEvents()` and write to the event store. This happens asynchronously (fire-and-forget) — event writes must never delay the tool result return.

The `before_agent_start` handler gains prompt capture: emit a `"prompt"` event with the user's prompt text.

The `session_start` handler is added: initialize the event store, capture session metadata.

### Phase 2 Data Flow

```
tool_result fires (any tool)
    │
    ├── Phase 1: compress if needed → return compressed content to LLM
    │
    └── Phase 2: extractEvents(event, sessionId)
         │
         ├── Parse typed details → TrackedEvent[]
         │
         └── eventStore.writeEvents(events)  [fire-and-forget, <5ms]
              │
              └── SQLite INSERT + FTS5 index update
```

```
before_agent_start fires
    │
    ├── Phase 1: inject routing instructions if ctx_* detected
    │
    └── Phase 2: eventStore.writeEvent({ category: "prompt", data: event.prompt })
```

---

## Phase 3: Compaction Integration

### Purpose

When OMP auto-compacts the session (context window full), inject a structured resume snapshot built from tracked events. The agent doesn't lose track of what it was doing — it gets an actionable narrative of the session state.

### Components

#### `src/context-mode/snapshot-builder.ts`

Builds a resume snapshot from the event store. The snapshot is a structured text block (<2KB) with the most important session state.

```typescript
/** Build a resume snapshot from tracked events for a session */
export function buildResumeSnapshot(
  eventStore: EventStore,
  sessionId: string,
): string;
```

**Snapshot structure:**

```xml
<session_knowledge>
  <last_request>[most recent user prompt]</last_request>
  <pending_tasks>
    - [task descriptions from "task" events that aren't marked complete]
  </pending_tasks>
  <key_decisions>
    - [extracted decisions from "decision" events]
  </key_decisions>
  <files_modified>
    - [deduplicated file paths from "file" write/edit events]
  </files_modified>
  <unresolved_errors>
    - [errors from "error" events not followed by a successful retry]
  </unresolved_errors>
  <git_state>
    - [latest branch, recent commits from "git" events]
  </git_state>
</session_knowledge>
```

Each section is capped: pending tasks (10), decisions (5), files (20), errors (3), git (5 recent commits). Total output stays under 2KB. Sections with no events are omitted entirely.

**Priority ordering**: Events are sorted by priority (critical → high → medium → low), then by recency within each priority. The snapshot takes the most recent events of each category up to the section cap.

#### `src/context-mode/hooks.ts` (extension)

Two new handlers registered when `config.contextMode.compaction` is true:

1. **`session_before_compact`** — Builds the resume snapshot from the event store. Returns `undefined` (does not cancel or replace compaction). The snapshot is stored in module-level state for the `session.compacting` handler to pick up.

2. **`session.compacting`** — Returns `{ context: string[], preserveData: { resumeSnapshot, eventCounts } }`. The `context` array contains the resume snapshot split into lines, injected into the compaction summary so the LLM sees session state when it resumes. `preserveData` stores the snapshot and event statistics for inspection.

### Phase 3 Data Flow

```
OMP triggers auto-compaction (context window full)
    │
    ▼
session_before_compact fires
    │
    ├── config.contextMode.compaction? No → no-op
    │
    └── Build resume snapshot from event store
         │
         ├── eventStore.getEvents(sessionId) → sorted by priority + recency
         │
         └── buildResumeSnapshot() → <2KB XML narrative
              │
              └── Store in module state for next handler
    │
    ▼
session.compacting fires
    │
    ├── Resume snapshot available? No → no-op
    │
    └── Return {
           context: [snapshot lines],
           preserveData: { resumeSnapshot, eventCounts }
         }
         │
         ▼
    OMP includes snapshot in compaction summary
         │
         ▼
    Agent resumes with session knowledge intact
```

---

## Phase 4: LLM Summarization

### Purpose

Optional enhancement to structural compression. For very large tool outputs (>16KB), use a fast model call to generate a high-quality summary instead of head/tail truncation. Produces more useful compressed output at the cost of latency and API usage.

### Components

#### `src/context-mode/compressor.ts` (extension)

The existing `compressToolResult()` gains an async variant:

```typescript
/** Compress with optional LLM summarization for very large outputs */
export async function compressToolResultWithLLM(
  event: ToolResultEvent,
  threshold: number,
  llmThreshold: number,
  summarize: (text: string, toolName: string) => Promise<string>,
): Promise<ToolResultEventResult | undefined>;
```

**Logic:**
1. All general rules still apply (isError passthrough, ImageContent passthrough).
2. If output < `threshold` (4KB): pass through.
3. If output ≥ `threshold` but < `llmThreshold` (16KB): structural compression (same as Phase 1).
4. If output ≥ `llmThreshold`: call `summarize()` to get LLM summary. On failure, fall back to structural compression.

The `summarize` function is injected by the hook registrar. It uses `pi.exec` or a direct API call to generate a summary. The summarization prompt is tool-aware:

- **Bash**: "Summarize this command output. Preserve: exit code, key findings, error messages, file paths mentioned."
- **Read**: "Summarize this file content. Preserve: file structure, key exports/functions, notable patterns."
- **Grep**: "Summarize these search results. Preserve: match count, most relevant matches, file distribution."

#### `src/context-mode/hooks.ts` (extension)

The `tool_result` handler checks `config.contextMode.llmSummarization`. When enabled, it uses `compressToolResultWithLLM()` instead of `compressToolResult()`. Since the LLM call is async and `tool_result` handlers can return promises, this works within the OMP event system.

The `summarize` function is built from the extension context: it uses the current model (from `ctx.model`) or a configured fast model, sends a single-turn summarization request, and returns the summary text. Target latency: 1-3 seconds.

### Phase 4 Data Flow

```
tool_result fires with very large output (32KB)
    │
    ├── output < 4KB? → pass through
    │
    ├── output 4KB-16KB? → structural compression (Phase 1)
    │
    └── output ≥ 16KB + llmSummarization enabled?
         │
         ├── Build summarization prompt for tool type
         │
         ├── Call model → get summary (~200 words)
         │
         ├── Success? → Return { content: [{ type: "text", text: summary }] }
         │
         └── Failure? → Fall back to structural compression
```

---

## Phase 5: Installation Management

### Purpose

Detect, install, and configure the context-mode MCP server from within supipowers. Users shouldn't need to manually install and configure context-mode — supipowers can handle it.

### Components

#### `src/context-mode/installer.ts`

Manages context-mode installation and MCP server configuration.

```typescript
/** Installation status */
export interface ContextModeInstallStatus {
  /** Whether the context-mode CLI is installed */
  cliInstalled: boolean;
  /** Whether context-mode is configured as an MCP server in OMP */
  mcpConfigured: boolean;
  /** Whether ctx_* tools are available in the current session */
  toolsAvailable: boolean;
  /** Installed version, if available */
  version: string | null;
}

/** Check context-mode installation status */
export async function checkInstallation(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>,
  activeTools: string[],
): Promise<ContextModeInstallStatus>;

/** Install context-mode globally */
export async function installContextMode(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>,
): Promise<{ success: boolean; error?: string }>;
```

**Installation flow:**

1. Check if `context-mode` CLI is available via `which context-mode` (or `pi.exec("npm", ["list", "-g", "context-mode"])`).
2. If not installed: run `pi.exec("npm", ["install", "-g", "context-mode"])`.
3. After install: verify with `pi.exec("context-mode", ["--version"])`.

**MCP configuration** is out of scope for this spec — OMP's MCP server registration is not done from extension code. The installer detects status and performs the npm install. The user configures MCP registration through OMP's standard mechanism (`.omp/mcp.json` or equivalent). The installer can emit a notification with setup instructions.

#### `/supi:config` (extension)

The existing `/supi:config` command gains a context-mode section. When the user runs `/supi:config`, it shows the context-mode installation status and offers to install if missing.

```
Context Mode:
  CLI installed: ✓ v1.2.3
  MCP configured: ✗ (run `omp mcp add context-mode` to enable)
  Tools available: ✗ (need MCP configuration + session restart)
```

If CLI is not installed:
```
Context Mode:
  CLI installed: ✗
  → Install context-mode? (y/n)
```

The config command handler calls `checkInstallation()` and conditionally calls `installContextMode()` with user confirmation via `ctx.ui.confirm()`.

---

## Config Shape

### `src/types.ts` (modification)

```typescript
export interface ContextModeConfig {
  /** Master toggle for all context-mode integration (default: true) */
  enabled: boolean;
  /** Byte threshold above which tool results are compressed (default: 4096) */
  compressionThreshold: number;
  /** Block curl/wget/HTTP commands and redirect to ctx_fetch_and_index (default: true) */
  blockHttpCommands: boolean;
  /** Inject routing instructions into system prompt when ctx_* tools detected (default: true) */
  routingInstructions: boolean;
  /** Track events from tool results in SQLite (default: true) */
  eventTracking: boolean;
  /** Inject session knowledge into compaction summaries (default: true) */
  compaction: boolean;
  /** Use LLM calls for summarizing very large outputs (default: false) */
  llmSummarization: boolean;
  /** Byte threshold above which LLM summarization is used instead of structural compression (default: 16384) */
  llmThreshold: number;
}
```

Added as `contextMode: ContextModeConfig` to `SupipowersConfig`.

### `src/config/defaults.ts` (modification)

```typescript
contextMode: {
  enabled: true,
  compressionThreshold: 4096,
  blockHttpCommands: true,
  routingInstructions: true,
  eventTracking: true,
  compaction: true,
  llmSummarization: false,   // off by default — adds latency + cost
  llmThreshold: 16384,
}
```

### `src/config/schema.ts` (modification)

Add TypeBox schema for the `contextMode` config section, mirroring the interface above with appropriate constraints (`compressionThreshold` minimum: 1024, `llmThreshold` minimum: 4096).

---

## Error Handling

### Phase 1

- **Compressor errors**: Caught and logged via `pi.logger.warn()`. Original content returned unmodified. A compression failure never breaks a tool call.
- **Detector errors**: Default to `{ available: false }`. Conservative — no routing, no blocking, compression still works standalone.
- **Skill loading errors**: Logged, routing instructions skipped for that turn. Compression still operates.
- **Config loading errors**: Fall through to defaults.

### Phase 2

- **EventStore init errors**: Logged via `pi.logger.error()`. Event tracking silently disabled for the session. All other features (compression, routing, blocking) continue to operate.
- **Event write errors**: Caught per-write, logged, and discarded. A failed write never delays or blocks the `tool_result` return. The event store uses WAL mode for write performance.
- **Event extraction errors**: If `extractEvents()` throws for a specific tool result, that result's events are lost but the tool result still passes through (compressed or raw) to the LLM.

### Phase 3

- **Snapshot build errors**: If `buildResumeSnapshot()` throws, the `session_before_compact` handler returns `undefined` (no snapshot). Compaction proceeds normally without session knowledge injection.
- **Compacting handler errors**: If the `session.compacting` handler throws, OMP falls back to default compaction. Session state is not preserved but the agent continues to work.

### Phase 4

- **LLM call errors**: Network failures, model errors, timeouts — all fall back to structural compression. Never blocks the tool result pipeline.
- **LLM call timeouts**: Configured timeout (default: 10s). If exceeded, fall back to structural compression.
- **Empty/unusable summaries**: If the model returns an empty or very short summary (<50 chars), fall back to structural compression.

### Phase 5

- **Installation errors**: Reported via `ctx.ui.notify()` with `type: "error"`. Never auto-retries. User can retry manually.
- **Permission errors**: If npm global install fails due to permissions, suggest `sudo` or alternative install methods in the notification.
- **Network errors**: Reported with suggestion to check connectivity.

---

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

### `tests/context-mode/event-store.test.ts`

Uses tmpdir fixture for SQLite database:
- Schema creation on init (tables + FTS5 + triggers)
- writeEvent persists and is queryable
- writeEvents writes multiple events in single transaction
- getEvents filters by category, priority, since, limit
- searchEvents uses FTS5 and returns ranked results
- getEventCounts returns correct category counts
- pruneEvents deletes old events and returns count
- Concurrent writes don't corrupt (WAL mode)
- close() releases the database connection

### `tests/context-mode/event-extractor.test.ts`

Per tool type:
- **Bash**: git commands → "git" event; non-zero exit → "error" event; cd commands → "cwd" event
- **Read**: emits "file" event with read op and path
- **Edit**: emits "file" event with edit op and path
- **Write**: emits "file" event with write op and path from input
- **Grep**: emits "file" event with search op and match count
- **Find**: emits "file" event with find op and file count
- Priority assignment matches the priority table
- Unknown tool types → empty array (no events)

### `tests/context-mode/snapshot-builder.test.ts`

- Builds snapshot with all sections when events exist
- Omits sections when no events for that category
- Respects section caps (10 tasks, 5 decisions, etc.)
- Output is under 2KB for large event sets
- Priority sorting: critical events appear before low-priority
- Recency sorting within same priority
- Empty event store → empty string (no snapshot)
- Handles sessions with only one category of events

### `tests/context-mode/installer.test.ts`

- Detects CLI installed via which command
- Detects CLI not installed
- Reports MCP configured status from active tools
- installContextMode calls npm install -g
- Reports version from context-mode --version
- Handles install failure gracefully
- Handles permission errors with clear message

---

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `src/context-mode/detector.ts` | Create | Context-mode MCP tool detection |
| `src/context-mode/compressor.ts` | Create | Structural + LLM summarization per tool type |
| `src/context-mode/hooks.ts` | Create | OMP event handler registration (all phases) |
| `src/context-mode/event-store.ts` | Create | SQLite schema + CRUD for event tracking |
| `src/context-mode/event-extractor.ts` | Create | Parse ToolResultEvent → TrackedEvent[] |
| `src/context-mode/snapshot-builder.ts` | Create | Build resume snapshot from events for compaction |
| `src/context-mode/installer.ts` | Create | Context-mode installation detection and management |
| `skills/context-mode/SKILL.md` | Create | Routing instructions for system prompt injection |
| `src/types.ts` | Modify | Add `ContextModeConfig` type and `contextMode` field to `SupipowersConfig` |
| `src/config/defaults.ts` | Modify | Add default values for `contextMode` config |
| `src/config/schema.ts` | Modify | Add TypeBox schema for `contextMode` config section |
| `src/index.ts` | Modify | Call `registerContextModeHooks()` during extension setup |
| `src/orchestrator/dispatcher.ts` | Modify | Inject routing instructions into sub-agent prompts when ctx_* detected |
| `src/orchestrator/prompts.ts` | Modify | Add `contextModeAvailable` parameter to prompt builders |
| `src/orchestrator/conflict-resolver.ts` | Modify | Forward `contextModeAvailable` flag to `buildMergePrompt()` |
| `src/commands/config.ts` | Modify | Add context-mode installation status + install option |
| `tests/context-mode/detector.test.ts` | Create | Detector unit tests |
| `tests/context-mode/compressor.test.ts` | Create | Compressor unit tests per tool type |
| `tests/context-mode/hooks.test.ts` | Create | Hook registration integration tests |
| `tests/context-mode/event-store.test.ts` | Create | SQLite event store unit tests |
| `tests/context-mode/event-extractor.test.ts` | Create | Event extraction unit tests per tool type |
| `tests/context-mode/snapshot-builder.test.ts` | Create | Snapshot builder unit tests |
| `tests/context-mode/installer.test.ts` | Create | Installation management unit tests |

## Out of Scope

- **Context-mode internal fork/modification**: We integrate with context-mode as-is. No patches to its source code or custom builds.
- **Multi-session event aggregation**: Events are per-session. Cross-session analytics or event merging is a separate concern.
- **Custom MCP tool registration**: Supipowers does not register its own MCP tools. It uses context-mode's tools when available.
