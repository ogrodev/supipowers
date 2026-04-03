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

| Source | API | What It Provides |
|---|---|---|
| `ctx.getContextUsage()` | ExtensionCommandContext | Authoritative token/byte counts from OMP runtime |
| `ctx.getSystemPrompt()` | ExtensionCommandContext | Raw system prompt text |
| `pi.getActiveTools()` | ExtensionAPI | List of currently active tool names |
| `pi.getAllTools()` | ExtensionAPI | List of all registered tool names |

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
    → ctx.getContextUsage()        → overall usage data (tokens, bytes)
    → ctx.getSystemPrompt()        → raw system prompt string
    → parseSystemPrompt(text)      → array of { label, content, bytes }
    → pi.getActiveTools()          → active tool name list
    → pi.getAllTools()              → all tool name list
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
Context Breakdown (total: ~148K tokens, 592KB)
────────────────────────────────────────────
  System Prompt          312KB   53%  ~78K tok
    ├ Base prompt          28KB    5%   ~7K tok
    ├ AGENTS.md            14KB    2%   ~3K tok
    ├ Skills (3)           42KB    7%  ~10K tok
    ├ Memory               8KB    1%   ~2K tok
    ├ Routing rules        86KB   15%  ~21K tok
    ├ MCP instructions    124KB   21%  ~31K tok
    └ Other                10KB    2%   ~2K tok
  Tools (47 active / 52 total) 180KB   30%  ~45K tok
  Conversation (23 msgs)  100KB   17%  ~25K tok
────────────────────────────────────────────
  Close
```

**Layout rules:**
- Section labels left-aligned, sizes right-aligned
- Sub-sections indented with tree characters (├, └)
- Percentages relative to the total context size
- "Close" item at the bottom (or Esc to dismiss)

### Graceful Degradation

- If `ctx.getContextUsage()` returns null → show "Usage data not available" and fall back to system prompt parsing only, skipping conversation/tool byte totals
- If `ctx.getSystemPrompt()` returns empty → show "No system prompt captured" with just the usage totals
- If parser finds no recognizable sections → show a single "System Prompt" line with total bytes, no sub-breakdown

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
