# `/supi:context` — Context Breakdown Command

**Date:** 2026-04-03
**Status:** Draft

## Goal

Add a `/supi:context` slash command that shows a detailed breakdown of what's consuming the LLM context window — system prompt sections, active tools, and conversation history — with byte sizes, estimated tokens, and percentages.

## Motivation

When working with OMP, the context window fills up from many sources: system prompt (AGENTS.md, skills, memory, routing rules, MCP instructions), tool definitions, and conversation history. Without visibility, it's impossible to know which parts are bloated or worth optimizing. This command gives that visibility as a zero-cost TUI-only operation.

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
| `src/commands/context.ts` | Command registration, input interception, TUI rendering |
| `src/context/analyzer.ts` | Pure functions: parse system prompt into sections, measure sizes, build display breakdown |
| `tests/context/analyzer.test.ts` | Unit tests for parser and breakdown builder |

### Data Flow

```
User types /supi:context
  → input event handler intercepts (returns { handled: true })
  → handleContext(platform, ctx) called
    → ctx.getContextUsage()        → { tokens, contextWindow, percent } (any field may be null)
    → ctx.getSystemPrompt()        → raw system prompt string
    → parseSystemPrompt(text)      → array of { label, content, bytes }
    → pi.getActiveTools()          → active tool name list
    → buildBreakdown(usage, sections, tools)  → formatted display lines
    → ctx.ui.select("Context Breakdown", lines)  → TUI display
```

## System Prompt Parser

The system prompt is assembled by OMP from multiple sources with recognizable structural patterns. The parser identifies sections by matching these patterns:

| Pattern | Label |
|---|---|
| `<file path="...AGENTS.md">...</file>` | AGENTS.md |
| `<file path="...">` (other files) | Project files |
| `<skills>...</skills>` or `<skill name="...">` | Skills |
| `# Memory Guidance` or `memory://` block | Memory |
| `# context-mode — MANDATORY routing rules` | Routing rules |
| `## MCP Server Instructions` | MCP instructions |
| `<instructions>...</instructions>` | Extension instructions |
| `<project>...</project>` | Project context |
| Everything not matched | Base system prompt |

### Parsing Strategy

1. Walk the system prompt string sequentially
2. Match section boundaries using the patterns above
3. For XML-like sections (`<file>`, `<skills>`, `<instructions>`, `<project>`), find the matching closing tag
4. For heading-based sections (`# Memory Guidance`, `## MCP Server Instructions`), capture until the next top-level heading or end of string
5. Track byte offsets for each section
6. Remaining unmatched text is labeled "Base system prompt"

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

The `ctx.getContextUsage()` return value provides authoritative totals. The per-section breakdown comes from parsing. If the parsed section sizes don't sum to the system prompt total (due to parser gaps), the remainder is attributed to "Other".

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
    ├ MCP instructions    124KB  ~31K tok
    └ Other                10KB   ~2K tok
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

```typescript
platform.registerCommand("supi:context", {
  description: "Show context window breakdown — what's consuming tokens",
  async handler(_args, ctx) {
    handleContext(platform, ctx);
  },
});
```

### Input Interception (TUI-only)

Add `"supi:context"` to the `TUI_COMMANDS` map in `bootstrap.ts` so it's intercepted at the input level and never triggers a "Working..." spinner.

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
- **Conversation message-level breakdown** — we show total conversation size and message count, not per-message details
- **Modifying context** — this command is read-only; it doesn't offer to remove/compress sections
