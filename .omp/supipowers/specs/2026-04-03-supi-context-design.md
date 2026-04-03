# `/supi:context` — Context Breakdown Command

**Date:** 2026-04-03
**Status:** Draft

## Goal

Add a `/supi:context` slash command that shows what's consuming the LLM context window. It provides: (1) a per-section breakdown of the system prompt with byte sizes and estimated tokens, (2) a count of active tools, and (3) overall token usage from the OMP runtime.

## Motivation

When working with OMP, the system prompt alone can grow large from many injected sources: AGENTS.md, skills, memory, routing rules, MCP instructions, and extension content. Without visibility, it's impossible to know which parts are bloated or worth optimizing. This command gives that visibility as a zero-cost TUI-only operation. It focuses on the system prompt (which we can fully measure) and surfaces overall token usage from the runtime.

## Architecture

### Command Type

**Type 2: Pure UI/Config** — no LLM involvement, zero tokens spent. Intercepted at the `input` event level so no "Working..." spinner appears.

### Data Sources

The command uses OMP's `ExtensionCommandContext` APIs (available in slash command handlers as `ctx`) and `ExtensionAPI` (`platform` in our abstraction). Since our `PlatformContext` type in `src/platform/types.ts` currently types `ctx` as `any`, these methods are accessed directly on the OMP-provided context object without needing to extend our platform abstraction.

| Source | API | What It Provides |
|---|---|---|
| `ctx.getContextUsage()` | ExtensionCommandContext | Overall token usage: `{ tokens, contextWindow, percent }` — values may be `null` after compaction |
| `ctx.getSystemPrompt()` | ExtensionCommandContext | Raw system prompt text (the full assembled prompt) |
| `pi.getActiveTools()` | ExtensionAPI (wrapped by platform) | List of currently active tool names |

**What we can measure directly:**

- **System prompt**: Full text from `ctx.getSystemPrompt()` — exact byte sizes per parsed section, and estimated tokens via chars/4 heuristic
- **Active tool count**: Tool names from `pi.getActiveTools()` — we show the count of active tools, **not** per-tool schema byte sizes (tool definition JSON is not exposed by the API)
- **Overall token usage**: From `ctx.getContextUsage()` — tokens used, context window size, and percentage. These are authoritative totals from the OMP runtime

**What we cannot measure:**

- Per-tool definition byte sizes (schema JSON not exposed)
- Conversation history byte size or message count (not available from command context)
- Total registered tool count (`pi.getAllTools()` exists on OMP's ExtensionAPI but is not wrapped by our platform adapter — we only show active tools)

### File Structure

| File | Responsibility |
|---|---|
| `src/commands/context.ts` | Command registration, TUI rendering via `handleContext()` |
| `src/context/analyzer.ts` | Pure functions: parse system prompt into sections, measure sizes, build display breakdown |
| `src/bootstrap.ts` | Add `"supi:context"` to `TUI_COMMANDS` map for input-level interception |
| `tests/context/analyzer.test.ts` | Unit tests for parser and breakdown builder |

### Data Flow

```
User types /supi:context
  → bootstrap.ts input handler matches TUI_COMMANDS["supi:context"]
  → calls handleContext(platform, ctx)
  → returns { action: "handled" } to prevent message submission
  → inside handleContext:
    → guard: if (!ctx.hasUI) → return silently (no-op in headless mode)
    → ctx.getContextUsage()        → { tokens, contextWindow, percent } (any field may be null)
    → ctx.getSystemPrompt()        → raw system prompt string
    → parseSystemPrompt(text)      → array of { label, content, bytes }
    → platform.getActiveTools()    → active tool name list
    → buildBreakdown(usage, sections, tools)  → formatted display lines
    → ctx.ui.select("Context Breakdown", lines)  → TUI display
```

## System Prompt Parser

The system prompt is assembled by OMP from multiple sources with recognizable structural patterns. The parser identifies sections by matching these patterns:

| Pattern | Label | Aggregation |
|---|---|---|
| `<file path="...AGENTS.md">...</file>` | AGENTS.md | Single entry |
| `<file path="...">` (other files) | File: `<basename>` | One entry per `<file>` tag, labeled by basename |
| `<skills>...</skills>` | Skills (N) | Single aggregated entry; N = count of `<skill>` tags inside |
| `# Memory Guidance` or `memory://` block | Memory | Single entry |
| `# context-mode — MANDATORY routing rules` | Routing rules | Single entry (captures all routing blocks — may appear multiple times, all merged) |
| `## MCP Server Instructions` | MCP instructions | Single entry |
| `<instructions>...</instructions>` | Extension instructions | Single entry |
| `<project>...</project>` | Project context | Single entry |
| Everything not matched | Base system prompt | Single entry — all unmatched fragments concatenated |

### Parsing Strategy

1. Walk the system prompt string sequentially, tracking a cursor position
2. For XML-like sections (`<file>`, `<skills>`, `<instructions>`, `<project>`): find matching closing tag, extract content between open and close tags (inclusive of tags)
3. For heading-based sections (`# Memory Guidance`, `## MCP Server Instructions`, `# context-mode`): capture from the heading to the next top-level heading (`#` or `##`) or end of string
4. All text between recognized sections (preamble, connective text, postamble) is concatenated into a single "Base system prompt" entry
5. If a `<skills>` wrapper is found, count inner `<skill name="...">` tags to produce the "Skills (N)" label. If no wrapper but individual `<skill>` tags exist, count and aggregate them the same way
6. Duplicate routing rule blocks (the same header appearing multiple times) are merged into one entry with combined byte size

### Section Output

```typescript
interface PromptSection {
  label: string;       // e.g., "AGENTS.md", "Skills (3)", "Routing rules"
  bytes: number;       // raw byte length (UTF-8)
  content: string;     // the raw section text (for potential drill-down later)
}
```

## Sizing

All sizes are displayed in two units:

- **KB** — `bytes / 1024`, rounded to nearest integer (or 1 decimal for < 10KB)
- **Estimated tokens** — `Math.ceil(chars / 4)` with `~` prefix to indicate approximation

The `ctx.getContextUsage()` return value provides authoritative token totals from OMP. The per-section breakdown is computed from the raw system prompt text. The sum of parsed section bytes should equal the system prompt's total byte length — no remainder is expected since all unmatched text goes into "Base system prompt".

## TUI Display

Rendered as a `ctx.ui.select()` read-only display list:

```
Context Breakdown (~78K / 200K tokens, 39%)
────────────────────────────────────────────
  System Prompt          312KB  ~78K tok
    ├ Base prompt          28KB   ~7K tok
    ├ AGENTS.md            14KB   ~3K tok
    ├ Skills (3)           42KB  ~10K tok
    ├ Memory               8KB   ~2K tok
    ├ Routing rules        86KB  ~21K tok
    └ MCP instructions    124KB  ~31K tok
  Tools: 47 active
  ──────────────────────────────────
  Close
```

**Layout rules:**
- Header shows authoritative data from `getContextUsage()`: tokens used, context window size, percentage
- System prompt sections show KB and estimated tokens (chars/4) — these are the only values we can size per-section
- Tool line shows counts only (no byte sizes — schema definitions are not exposed)
- If `getContextUsage()` provides additional fields beyond what we expect, we display what's available
- "Close" item at the bottom (or Esc to dismiss)

### Graceful Degradation

| Condition | Behavior |
|----|-----|
| `ctx.getContextUsage()` returns null/undefined | Show "Usage data not available" — display system prompt breakdown only |
| `ctx.getContextUsage()` returns object with null `tokens` or `percent` | Show available fields, omit null ones (e.g., show context window size but skip percentage) |
| `ctx.getSystemPrompt()` returns empty/null | Show "No system prompt captured" — display only usage totals and tool counts |
| Parser finds no recognizable sections | Show single "System Prompt" line with total bytes, no sub-breakdown |
| Both usage and system prompt unavailable | Show notification: "Context data unavailable" and return |

## Registration

### Command Registration

In `src/commands/context.ts`, export the registration function:

```typescript
export function registerContextCommand(platform: Platform): void {
  platform.registerCommand("supi:context", {
    description: "Show context window breakdown — what's consuming tokens",
    async handler(_args, ctx) {
      handleContext(platform, ctx);
    },
  });
}
```

### Bootstrap Integration (`src/bootstrap.ts`)

1. Import `registerContextCommand` and `handleContext` from `src/commands/context.ts`
2. Call `registerContextCommand(platform)` alongside the other command registrations
3. Add `"supi:context": (platform, ctx) => handleContext(platform, ctx)` to the `TUI_COMMANDS` map

This follows the exact pattern used by existing commands like `supi:config`, `supi:status`, etc.

### Non-Interactive Fallback

If `ctx.hasUI` is false (headless/SDK mode), the command returns silently — no error, no output. This matches the convention of other TUI-only commands in the codebase.

## Error Handling

- All API calls wrapped in try/catch — failures degrade gracefully (show what we can)
- No thrown errors reach the user — worst case is a "Context data unavailable" notification
- Parser errors for individual sections don't block other sections from displaying

## Testing

### Unit Tests (`tests/context/analyzer.test.ts`)

**`parseSystemPrompt()`:**
- Parse a realistic system prompt with all section types (AGENTS.md, skills, memory, routing, MCP, project, instructions)
- Verify each section is extracted with correct label and approximate byte size
- Empty string → returns empty array
- Prompt with no recognizable sections → returns single "Base system prompt" entry
- Prompt with only some section types → correctly identifies present ones, remainder is base
- Nested XML tags (e.g., `<file>` inside `<project>`) — handled without double-counting
- Multiple skills → counted and labeled as "Skills (N)"

**`estimateTokens()`:**
- Known string → expected token count (chars / 4, ceiling)
- Empty string → 0

**`buildBreakdown()`:**
- Full data (usage + sections + tools) → formatted lines with correct percentages
- Missing usage data → degraded output without totals
- Missing system prompt → shows only usage totals

**`formatSize()`:**
- Bytes to human-readable KB with appropriate precision
- Edge cases: 0 bytes, very large values

## Non-Goals

- **Live monitoring** — this is a point-in-time snapshot, not a persistent widget
- **Token counting accuracy** — we use chars/4 estimation, not a real tokenizer
- **Drill-down into individual tool schemas** — we show tool counts, not per-tool definition sizes (the `context` event hook could enable this later but is out of scope)
- **Conversation history breakdown** — not available from command context APIs; would require the `context` event hook (future scope)
- **Modifying context** — this command is read-only; it doesn't offer to remove/compress sections
