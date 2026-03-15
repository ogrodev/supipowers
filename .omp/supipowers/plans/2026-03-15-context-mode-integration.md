---
name: context-mode-integration
created: 2026-03-15
tags: [context-mode, compression, events, compaction, hooks]
---

# Context Mode Integration — Implementation Plan

**Goal:** Integrate context-mode capabilities into supipowers: native result compression, tool routing, event tracking, compaction-aware session continuity, LLM summarization, and installation management.

**Architecture:** Five-phase integration using OMP's ExtensionAPI hooks (`tool_result`, `tool_call`, `before_agent_start`, `session_before_compact`, `session.compacting`). Phase 1 provides native result compression + routing. Phase 2 adds SQLite event tracking. Phase 3 wires compaction hooks. Phase 4 adds optional LLM summarization. Phase 5 adds installation management.

**Tech Stack:** TypeScript, OMP ExtensionAPI (`@oh-my-pi/pi-coding-agent`), `bun:sqlite`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-context-mode-integration-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/context-mode/detector.ts` | Detect ctx_* MCP tools from `pi.getActiveTools()` |
| `src/context-mode/compressor.ts` | Structural + LLM compression per tool type |
| `src/context-mode/hooks.ts` | Register all OMP event handlers for context-mode |
| `src/context-mode/event-store.ts` | SQLite CRUD for session events + FTS5 search |
| `src/context-mode/event-extractor.ts` | Parse ToolResultEvent → TrackedEvent[] |
| `src/context-mode/snapshot-builder.ts` | Build resume snapshot for compaction |
| `src/context-mode/installer.ts` | Detect/install context-mode CLI |
| `skills/context-mode/SKILL.md` | Routing instructions for system prompt injection |
| `tests/context-mode/detector.test.ts` | Detector unit tests |
| `tests/context-mode/compressor.test.ts` | Compressor unit tests |
| `tests/context-mode/hooks.test.ts` | Hook registration tests |
| `tests/context-mode/event-store.test.ts` | Event store unit tests |
| `tests/context-mode/event-extractor.test.ts` | Event extraction tests |
| `tests/context-mode/snapshot-builder.test.ts` | Snapshot builder tests |
| `tests/context-mode/installer.test.ts` | Installer tests |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Add `ContextModeConfig` interface + field on `SupipowersConfig` |
| `src/config/defaults.ts` | Add `contextMode` defaults |
| `src/config/schema.ts` | Add TypeBox schema for `contextMode` |
| `src/index.ts` | Call `registerContextModeHooks()` |
| `src/orchestrator/dispatcher.ts` | Pass `contextModeAvailable` to prompt builder |
| `src/orchestrator/prompts.ts` | Add `contextModeAvailable` parameter |
| `src/orchestrator/conflict-resolver.ts` | Forward `contextModeAvailable` to `buildMergePrompt()` |
| `src/commands/config.ts` | Add context-mode install status + action |

---

## Chunk 1: Foundation

Types, config, schema, and detector. Everything else depends on these.

### Task 1: Add ContextModeConfig type [parallel-safe]

**Files:**
- Modify: `src/types.ts`
- Test: `tests/config/loader.test.ts` (existing — verify merge still works)

- [ ] **Step 1: Write the failing test**

Add a test to verify the config shape includes `contextMode`:

```typescript
// Append to tests/config/loader.test.ts
describe("contextMode config", () => {
  test("DEFAULT_CONFIG includes contextMode with all fields", () => {
    const config = DEFAULT_CONFIG;
    expect(config.contextMode).toBeDefined();
    expect(config.contextMode.enabled).toBe(true);
    expect(config.contextMode.compressionThreshold).toBe(4096);
    expect(config.contextMode.blockHttpCommands).toBe(true);
    expect(config.contextMode.routingInstructions).toBe(true);
    expect(config.contextMode.eventTracking).toBe(true);
    expect(config.contextMode.compaction).toBe(true);
    expect(config.contextMode.llmSummarization).toBe(false);
    expect(config.contextMode.llmThreshold).toBe(16384);
  });

  test("deepMerge applies contextMode overrides", () => {
    const config = deepMerge(DEFAULT_CONFIG, {
      contextMode: { compressionThreshold: 8192 },
    });
    expect(config.contextMode.compressionThreshold).toBe(8192);
    expect(config.contextMode.enabled).toBe(true); // untouched fields preserved
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/loader.test.ts`
Expected: FAIL — `contextMode` does not exist on `SupipowersConfig`

- [ ] **Step 3: Write the type and defaults**

In `src/types.ts`, add after the `SupipowersConfig` interface definition:

```typescript
/** Context-mode integration settings */
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

Add `contextMode: ContextModeConfig;` to the `SupipowersConfig` interface.

In `src/config/defaults.ts`, add to `DEFAULT_CONFIG`:

```typescript
contextMode: {
  enabled: true,
  compressionThreshold: 4096,
  blockHttpCommands: true,
  routingInstructions: true,
  eventTracking: true,
  compaction: true,
  llmSummarization: false,
  llmThreshold: 16384,
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config/loader.test.ts`
Expected: PASS

- [ ] **Step 5: Update the TypeBox schema**

In `src/config/schema.ts`, add inside the `ConfigSchema` object:

```typescript
contextMode: Type.Object({
  enabled: Type.Boolean(),
  compressionThreshold: Type.Number({ minimum: 1024 }),
  blockHttpCommands: Type.Boolean(),
  routingInstructions: Type.Boolean(),
  eventTracking: Type.Boolean(),
  compaction: Type.Boolean(),
  llmSummarization: Type.Boolean(),
  llmThreshold: Type.Number({ minimum: 4096 }),
}),
```

- [ ] **Step 6: Run all config tests**

Run: `bun test tests/config/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config/defaults.ts src/config/schema.ts tests/config/loader.test.ts
git commit -m "feat(context-mode): add ContextModeConfig type, defaults, and schema"
```

---

### Task 2: Create context-mode detector [parallel-safe]

**Files:**
- Create: `src/context-mode/detector.ts`
- Create: `tests/context-mode/detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/detector.test.ts
import { detectContextMode } from "../../src/context-mode/detector.js";

describe("detectContextMode", () => {
  test("returns available: true when all ctx_* tools present", () => {
    const tools = [
      "bash", "read", "edit",
      "ctx_execute", "ctx_batch_execute", "ctx_execute_file",
      "ctx_index", "ctx_search", "ctx_fetch_and_index",
    ];
    const status = detectContextMode(tools);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(true);
    expect(status.tools.ctxExecuteFile).toBe(true);
    expect(status.tools.ctxIndex).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxFetchAndIndex).toBe(true);
  });

  test("returns available: false when no ctx_* tools present", () => {
    const status = detectContextMode(["bash", "read", "edit", "grep"]);
    expect(status.available).toBe(false);
    expect(status.tools.ctxExecute).toBe(false);
    expect(status.tools.ctxSearch).toBe(false);
  });

  test("detects partial availability", () => {
    const status = detectContextMode(["bash", "ctx_execute", "ctx_search"]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(false);
    expect(status.tools.ctxIndex).toBe(false);
  });

  test("returns available: false for empty tools list", () => {
    const status = detectContextMode([]);
    expect(status.available).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/detector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/detector.ts

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

const TOOL_MAP: Record<string, keyof ContextModeStatus["tools"]> = {
  ctx_execute: "ctxExecute",
  ctx_batch_execute: "ctxBatchExecute",
  ctx_execute_file: "ctxExecuteFile",
  ctx_index: "ctxIndex",
  ctx_search: "ctxSearch",
  ctx_fetch_and_index: "ctxFetchAndIndex",
};

/** Detect context-mode MCP tool availability from the active tools list */
export function detectContextMode(activeTools: string[]): ContextModeStatus {
  const tools: ContextModeStatus["tools"] = {
    ctxExecute: false,
    ctxBatchExecute: false,
    ctxExecuteFile: false,
    ctxIndex: false,
    ctxSearch: false,
    ctxFetchAndIndex: false,
  };

  for (const tool of activeTools) {
    const key = TOOL_MAP[tool];
    if (key) tools[key] = true;
  }

  const available = Object.values(tools).some(Boolean);
  return { available, tools };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/detector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-mode/detector.ts tests/context-mode/detector.test.ts
git commit -m "feat(context-mode): add context-mode MCP tool detector"
```

---

## Chunk 2: Phase 1 — Result Compression + Hooks + Routing

### Task 3: Create structural compressor [sequential: depends on 1]

**Files:**
- Create: `src/context-mode/compressor.ts`
- Create: `tests/context-mode/compressor.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/compressor.test.ts
import { compressToolResult } from "../../src/context-mode/compressor.js";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

// Helper to create a text-only tool result event
function bashResult(
  text: string,
  details?: { exitCode?: number },
  isError = false,
): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "test-id",
    input: { command: "test" },
    content: [{ type: "text", text }],
    isError,
    details: details ? { exitCode: details.exitCode ?? 0 } : undefined,
  } as ToolResultEvent;
}

function readResult(
  text: string,
  input?: { offset?: number; limit?: number },
  isError = false,
): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "test-id",
    input: { path: "/test/file.ts", ...input },
    content: [{ type: "text", text }],
    isError,
    details: undefined,
  } as ToolResultEvent;
}

function grepResult(text: string, isError = false): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "grep",
    toolCallId: "test-id",
    input: { pattern: "test", path: "src/" },
    content: [{ type: "text", text }],
    isError,
    details: undefined,
  } as ToolResultEvent;
}

function findResult(text: string, isError = false): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "find",
    toolCallId: "test-id",
    input: { pattern: "*.ts" },
    content: [{ type: "text", text }],
    isError,
    details: undefined,
  } as ToolResultEvent;
}

const THRESHOLD = 100; // Low threshold for testing

describe("compressToolResult", () => {
  describe("general rules", () => {
    test("returns undefined when output is below threshold", () => {
      const result = compressToolResult(bashResult("small output"), THRESHOLD);
      expect(result).toBeUndefined();
    });

    test("returns undefined when event.isError is true", () => {
      const bigError = "x".repeat(THRESHOLD + 1);
      const result = compressToolResult(bashResult(bigError, undefined, true), THRESHOLD);
      expect(result).toBeUndefined();
    });

    test("returns undefined when content contains ImageContent", () => {
      const event = {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "test-id",
        input: { command: "test" },
        content: [
          { type: "text", text: "x".repeat(THRESHOLD + 1) },
          { type: "image", source: { type: "base64", data: "...", media_type: "image/png" } },
        ],
        isError: false,
        details: undefined,
      } as unknown as ToolResultEvent;
      const result = compressToolResult(event, THRESHOLD);
      expect(result).toBeUndefined();
    });

    test("returns undefined for unrecognized tool types", () => {
      const event = {
        type: "tool_result",
        toolName: "unknown_tool",
        toolCallId: "test-id",
        input: {},
        content: [{ type: "text", text: "x".repeat(THRESHOLD + 1) }],
        isError: false,
        details: undefined,
      } as unknown as ToolResultEvent;
      const result = compressToolResult(event, THRESHOLD);
      expect(result).toBeUndefined();
    });

    test("measures threshold against text content only", () => {
      // Exactly at threshold — should NOT compress
      const result = compressToolResult(bashResult("x".repeat(THRESHOLD)), THRESHOLD);
      expect(result).toBeUndefined();
    });
  });

  describe("bash compression", () => {
    test("keeps full output for non-zero exit code", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const event = bashResult(lines, { exitCode: 1 });
      const result = compressToolResult(event, THRESHOLD);
      // Non-zero exit code: keep full output
      expect(result).toBeUndefined();
    });

    test("compresses successful output with head/tail", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const event = bashResult(lines, { exitCode: 0 });
      const result = compressToolResult(event, THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      expect(text.text).toContain("line 0"); // first lines kept
      expect(text.text).toContain("line 49"); // last lines kept
      expect(text.text).toContain("[...compressed:"); // marker present
      expect(text.text).toContain("lines omitted...]");
    });
  });

  describe("read compression", () => {
    test("passes through scoped reads (with offset/limit)", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const result = compressToolResult(
        readResult(lines, { offset: 10, limit: 20 }),
        THRESHOLD,
      );
      expect(result).toBeUndefined();
    });

    test("compresses full file reads to preview", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const result = compressToolResult(readResult(lines), THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      expect(text.text).toContain("line 0"); // preview lines kept
      expect(text.text).toContain("50 lines total");
    });
  });

  describe("grep compression", () => {
    test("compresses to first N matches", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `file${i}.ts:${i}: match ${i}`).join("\n");
      const result = compressToolResult(grepResult(lines), THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      expect(text.text).toContain("file0.ts"); // first matches kept
      expect(text.text).toContain("50 matches total");
    });
  });

  describe("find compression", () => {
    test("compresses to first N paths", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`).join("\n");
      const result = compressToolResult(findResult(lines), THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      expect(text.text).toContain("src/file0.ts"); // first paths kept
      expect(text.text).toContain("50 files found");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/compressor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/compressor.ts

interface TextContent {
  type: "text";
  text: string;
}

interface ToolResultEventLike {
  toolName: string;
  input: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  details: unknown;
}

interface ToolResultEventResult {
  content?: Array<{ type: string; text: string }>;
}

const BASH_HEAD_LINES = 5;
const BASH_TAIL_LINES = 10;
const READ_PREVIEW_LINES = 10;
const GREP_MAX_MATCHES = 10;
const FIND_MAX_PATHS = 20;

/** Measure total byte length of text content entries */
function measureTextBytes(content: Array<{ type: string; text?: string }>): number {
  let total = 0;
  for (const entry of content) {
    if (entry.type === "text" && entry.text) {
      total += new TextEncoder().encode(entry.text).byteLength;
    }
  }
  return total;
}

/** Check if content contains any non-text entries */
function hasNonTextContent(content: Array<{ type: string }>): boolean {
  return content.some((entry) => entry.type !== "text");
}

/** Get combined text from all text content entries */
function getCombinedText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((entry) => entry.type === "text" && entry.text)
    .map((entry) => entry.text!)
    .join("\n");
}

/** Compress bash tool output */
function compressBash(text: string, details: unknown): string | undefined {
  const exitCode =
    details && typeof details === "object" && "exitCode" in details
      ? (details as { exitCode: number }).exitCode
      : 0;

  // Non-zero exit: keep full output for debugging
  if (exitCode !== 0) return undefined;

  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= BASH_HEAD_LINES + BASH_TAIL_LINES) return undefined;

  const head = lines.slice(0, BASH_HEAD_LINES);
  const tail = lines.slice(-BASH_TAIL_LINES);
  const omitted = totalLines - BASH_HEAD_LINES - BASH_TAIL_LINES;

  return [
    ...head,
    `[...compressed: ${omitted} lines omitted (${totalLines} lines total)...]`,
    ...tail,
  ].join("\n");
}

/** Compress read tool output */
function compressRead(text: string, input: Record<string, unknown>): string | undefined {
  // Scoped reads (offset/limit) are already targeted — pass through
  if (input.offset !== undefined || input.limit !== undefined) return undefined;

  const lines = text.split("\n");
  const totalLines = lines.length;
  const path = typeof input.path === "string" ? input.path : "unknown";

  if (totalLines <= READ_PREVIEW_LINES) return undefined;

  const preview = lines.slice(0, READ_PREVIEW_LINES);
  return [
    `File: ${path} (${totalLines} lines total)`,
    "",
    ...preview,
    `[...compressed: remaining ${totalLines - READ_PREVIEW_LINES} lines omitted...]`,
  ].join("\n");
}

/** Compress grep tool output */
function compressGrep(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalMatches = lines.length;

  if (totalMatches <= GREP_MAX_MATCHES) return undefined;

  const kept = lines.slice(0, GREP_MAX_MATCHES);
  return [
    `${totalMatches} matches total, showing first ${GREP_MAX_MATCHES}:`,
    "",
    ...kept,
    `[...compressed: ${totalMatches - GREP_MAX_MATCHES} more matches omitted...]`,
  ].join("\n");
}

/** Compress find tool output */
function compressFind(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const totalFiles = lines.length;

  if (totalFiles <= FIND_MAX_PATHS) return undefined;

  const kept = lines.slice(0, FIND_MAX_PATHS);
  return [
    `${totalFiles} files found, showing first ${FIND_MAX_PATHS}:`,
    "",
    ...kept,
    `[...compressed: ${totalFiles - FIND_MAX_PATHS} more files omitted...]`,
  ].join("\n");
}

/** Compress a tool result if it exceeds the threshold */
export function compressToolResult(
  event: ToolResultEventLike,
  threshold: number,
): ToolResultEventResult | undefined {
  // General rules: pass through errors, non-text content, and small outputs
  if (event.isError) return undefined;
  if (hasNonTextContent(event.content)) return undefined;
  if (measureTextBytes(event.content) <= threshold) return undefined;

  const text = getCombinedText(event.content);
  let compressed: string | undefined;

  switch (event.toolName) {
    case "bash":
      compressed = compressBash(text, event.details);
      break;
    case "read":
      compressed = compressRead(text, event.input);
      break;
    case "grep":
      compressed = compressGrep(text);
      break;
    case "find":
      compressed = compressFind(text);
      break;
    default:
      return undefined;
  }

  if (!compressed) return undefined;
  return { content: [{ type: "text", text: compressed }] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/compressor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-mode/compressor.ts tests/context-mode/compressor.test.ts
git commit -m "feat(context-mode): add structural compressor for bash/read/grep/find"
```

---

### Task 4: Create routing skill file [parallel-safe]

**Files:**
- Create: `skills/context-mode/SKILL.md`

- [ ] **Step 1: Write the skill file**

```markdown
# Context Mode — Tool Routing Instructions

When context-mode sandbox tools are available, prefer them over raw tool calls to keep your context window lean.

## Tool Selection Hierarchy

Use context-mode tools in this priority order:

1. **ctx_batch_execute** — for multi-step operations. Runs multiple commands and searches in a single call.
   - Use when: you need to run 2+ commands, or combine a command with a search
   - Example: checking a build AND searching for a symbol

2. **ctx_search** — for querying previously indexed knowledge. No re-execution needed.
   - Use when: you've already indexed data and need to find something in it
   - Example: finding a function definition you indexed earlier

3. **ctx_execute / ctx_execute_file** — for single commands or file processing.
   - Use when: running one command whose output would be large
   - Example: listing a directory, reading a large log file

4. **Raw Bash/Read/Grep** — only when necessary.
   - Use when: editing files (Read before Edit), running build/test commands where real-time output matters, or when the output is known to be small

## Forbidden Patterns

- Do NOT use Bash for `curl`/`wget`/HTTP requests — use `ctx_fetch_and_index` instead
- Do NOT use Read for analyzing large files (>100 lines) — use `ctx_execute_file` to process and summarize
- Do NOT use Bash for directory listings with >20 expected files — use `ctx_execute`

## Output Constraints

- Keep tool output responses under 500 words when possible
- Write large artifacts (generated code, data dumps) to files rather than returning them inline
- Prefer structured summaries over raw output

## Sub-Agent Awareness

These routing instructions apply within sub-agent sessions. When you are a sub-agent dispatched by supipowers, follow the same tool preference hierarchy.
```

- [ ] **Step 2: Commit**

```bash
git add skills/context-mode/SKILL.md
git commit -m "feat(context-mode): add routing instructions skill file"
```

---

### Task 5: Create hooks registrar (Phase 1 only) [sequential: depends on 1, 2, 3]

**Files:**
- Create: `src/context-mode/hooks.ts`
- Create: `tests/context-mode/hooks.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/hooks.test.ts
import { registerContextModeHooks, _resetCache } from "../../src/context-mode/hooks.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import type { SupipowersConfig } from "../../src/types.js";

function createMockPi() {
  const handlers = new Map<string, Function>();
  return {
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler);
    }),
    getActiveTools: vi.fn(() => [] as string[]),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    _handlers: handlers,
  } as any;
}

describe("registerContextModeHooks", () => {
  beforeEach(() => {
    _resetCache();
  });

  test("registers hooks when enabled", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);
    expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  test("does not register hooks when disabled", () => {
    const pi = createMockPi();
    const config: SupipowersConfig = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, enabled: false },
    };
    registerContextModeHooks(pi, config);
    expect(pi.on).not.toHaveBeenCalled();
  });

  test("tool_result handler compresses large bash output", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_result");
    expect(handler).toBeDefined();

    const bigOutput = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls" },
      content: [{ type: "text", text: bigOutput }],
      isError: false,
      details: { exitCode: 0 },
    };

    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.content[0].text).toContain("[...compressed:");
  });

  test("tool_result handler passes through small output", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_result");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "hi" }],
      isError: false,
      details: { exitCode: 0 },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_call handler blocks curl when context-mode detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.block).toBe(true);
    expect(result.reason).toContain("ctx_fetch_and_index");
  });

  test("tool_call handler passes through curl when context-mode not detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "read"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "curl https://example.com/api" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("tool_call handler passes through non-HTTP bash commands", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "ctx_fetch_and_index"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("tool_call");
    const event = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "ls -la" },
    };

    const result = handler(event, {});
    expect(result).toBeUndefined();
  });

  test("before_agent_start handler concatenates routing when context-mode detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "ctx_execute", "ctx_search"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };
    const result = handler(event, {});
    expect(result).toBeDefined();
    expect(result.systemPrompt).toContain("You are an assistant.");
    expect(result.systemPrompt).toContain("Context Mode");
  });

  test("before_agent_start handler is no-op when context-mode not detected", () => {
    const pi = createMockPi();
    pi.getActiveTools.mockReturnValue(["bash", "read"]);
    registerContextModeHooks(pi, DEFAULT_CONFIG);

    const handler = pi._handlers.get("before_agent_start");
    const event = { prompt: "fix the bug", systemPrompt: "You are an assistant." };
    const result = handler(event, {});
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/hooks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/hooks.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SupipowersConfig } from "../types.js";
import { compressToolResult } from "./compressor.js";
import { detectContextMode, type ContextModeStatus } from "./detector.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Cached detection result
let cachedStatus: ContextModeStatus | null = null;

/** HTTP command patterns for blocking */
const HTTP_PATTERNS = [
  /^\s*curl\s/,
  /^\s*wget\s/,
  /\bcurl\s+(-[a-zA-Z]*\s+)*https?:\/\//,
  /\bwget\s+(-[a-zA-Z]*\s+)*https?:\/\//,
];

function isHttpCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return HTTP_PATTERNS.some((p) => p.test(command));
}

function loadRoutingSkill(): string | null {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const skillPath = join(__dirname, "..", "..", "skills", "context-mode", "SKILL.md");
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
}

/** Register context-mode hooks on the extension API */
export function registerContextModeHooks(pi: ExtensionAPI, config: SupipowersConfig): void {
  if (!config.contextMode.enabled) return;

  // Phase 1: Result compression
  pi.on("tool_result", (event) => {
    return compressToolResult(event, config.contextMode.compressionThreshold);
  });

  // Phase 1: Command blocking
  pi.on("tool_call", (event) => {
    if (!config.contextMode.blockHttpCommands) return;
    if (event.toolName !== "bash") return;

    const command = event.input?.command;
    if (!isHttpCommand(command)) return;

    // Only block if context-mode has a replacement tool
    if (!cachedStatus) cachedStatus = detectContextMode(pi.getActiveTools());
    if (!cachedStatus.tools.ctxFetchAndIndex) return;

    return {
      block: true,
      reason:
        "Use ctx_fetch_and_index instead of curl/wget. " +
        "It fetches the URL, indexes the content, and returns a compressed summary.",
    };
  });

  // Phase 1: Routing instructions
  pi.on("before_agent_start", (event) => {
    if (!config.contextMode.routingInstructions) return;
    if (!cachedStatus) cachedStatus = detectContextMode(pi.getActiveTools());
    if (!cachedStatus.available) return;

    const skill = loadRoutingSkill();
    if (!skill) return;

    const systemPrompt = (event as any).systemPrompt as string | undefined;
    if (!systemPrompt) return { systemPrompt: skill };
    return { systemPrompt: systemPrompt + "\n\n" + skill };
  });
}

/** Reset cached state (for testing) */
export function _resetCache(): void {
  cachedStatus = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into extension entry point**

In `src/index.ts`, add import and call:

```typescript
import { registerContextModeHooks } from "./context-mode/hooks.js";
```

Inside the `supipowers()` function, after registering commands:

```typescript
// Context-mode integration
const config = loadConfig(process.cwd());
registerContextModeHooks(pi, config);
```

Add the `loadConfig` import if not already present:

```typescript
import { loadConfig } from "./config/loader.js";
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/context-mode/hooks.ts tests/context-mode/hooks.test.ts src/index.ts
git commit -m "feat(context-mode): register Phase 1 hooks (compression, blocking, routing)"
```

---

### Task 6: Wire orchestrator prompt routing [sequential: depends on 2, 4]

**Files:**
- Modify: `src/orchestrator/prompts.ts`
- Modify: `src/orchestrator/dispatcher.ts`
- Modify: `src/orchestrator/conflict-resolver.ts`

- [ ] **Step 1: Update `buildTaskPrompt` to accept `contextModeAvailable`**

In `src/orchestrator/prompts.ts`, modify `buildTaskPrompt`:

```typescript
export function buildTaskPrompt(
  task: PlanTask,
  planContext: string,
  config: SupipowersConfig,
  lspAvailable: boolean,
  contextModeAvailable = false,
  workDir?: string,
): string {
```

**Important**: The existing `if (lspAvailable)` block does an early `return`. Refactor it to append instead of return, so both LSP and context-mode sections can coexist. Build the prompt incrementally:

```typescript
  let result = prompt;

  if (lspAvailable) {
    result = [
      result,
      "",
      "## LSP Available",
      "You have access to the LSP tool. Use it to:",
      "- Check diagnostics after making changes",
      "- Find references before renaming symbols",
      "- Validate your work has no type errors",
      "",
      buildLspValidationPrompt(task.files),
    ].join("\n");
  }

  if (contextModeAvailable) {
    result = [
      result,
      "",
      "## Context Mode Available",
      "You have access to context-mode sandbox tools. Prefer them for large operations:",
      "- Use `ctx_batch_execute` for multi-step operations",
      "- Use `ctx_search` for querying indexed knowledge",
      "- Use `ctx_execute` for single commands with large output",
      "- Do NOT use `curl`/`wget` \u2014 use `ctx_fetch_and_index`",
      "- Do NOT use Read for analyzing large files \u2014 use `ctx_execute_file`",
      "- Keep output under 500 words; write large artifacts to files",
    ].join("\n");
  }

  return result;
```

- [ ] **Step 2: Update `buildFixPrompt` and `buildMergePrompt`**

Add `contextModeAvailable = false` parameter to both. Append the same routing block when true. Follow the same pattern as the LSP block.

- [ ] **Step 3: Update dispatcher to detect and pass context-mode status**

In `src/orchestrator/dispatcher.ts`:

Add import:
```typescript
import { detectContextMode } from "../context-mode/detector.js";
```

Add `contextModeAvailable` to `DispatchOptions`:
```typescript
export interface DispatchOptions {
  pi: ExtensionAPI;
  ctx: { cwd: string; ui: { notify(msg: string, type?: "info" | "warning" | "error"): void } };
  task: PlanTask;
  planContext: string;
  config: SupipowersConfig;
  lspAvailable: boolean;
  contextModeAvailable: boolean;  // new field
}
```

In `dispatchAgent()`, use the field:
```typescript
const { pi, ctx, task, planContext, config, lspAvailable, contextModeAvailable } = options;
const prompt = buildTaskPrompt(task, planContext, config, lspAvailable, contextModeAvailable);
```

In `dispatchFixAgent()`, destructure and forward:
```typescript
const { pi, ctx, task, config, lspAvailable, contextModeAvailable, previousOutput, failureReason } = options;
const prompt = buildFixPrompt(task, previousOutput, failureReason, lspAvailable, contextModeAvailable);
```

In `src/commands/run.ts`, compute and pass `contextModeAvailable` when constructing `DispatchOptions`:
```typescript
const contextModeAvailable = detectContextMode(pi.getActiveTools()).available;
// Pass to every dispatchAgent / dispatchAgentWithReview call
```

- [ ] **Step 4: Update conflict-resolver**

In `src/orchestrator/conflict-resolver.ts`, add `contextModeAvailable` parameter to `analyzeConflicts()` and forward to `buildMergePrompt()`:

```typescript
export function analyzeConflicts(
  results: AgentResult[],
  tasks: PlanTask[],
  contextModeAvailable = false,
): ConflictResolution {
  // ...existing code...
  return {
    hasConflicts: true,
    conflictingFiles,
    mergePrompt: buildMergePrompt(conflictingFiles, agentOutputs, contextModeAvailable),
  };
}
```

Update the caller in `src/commands/run.ts` to pass `contextModeAvailable`:
```typescript
const conflicts = analyzeConflicts(batchResults, plan.tasks, contextModeAvailable);
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/prompts.ts src/orchestrator/dispatcher.ts src/orchestrator/conflict-resolver.ts src/commands/run.ts
git commit -m "feat(context-mode): wire context-mode routing into orchestrator prompts"
```

---

## Chunk 3: Phase 2 — Event Tracking

### Task 7: Create event store [parallel-safe]

**Files:**
- Create: `src/context-mode/event-store.ts`
- Create: `tests/context-mode/event-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/event-store.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore, type EventCategory, type TrackedEvent } from "../../src/context-mode/event-store.js";

let tmpDir: string;
let store: EventStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-events-"));
  store = new EventStore(path.join(tmpDir, "events.db"));
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function event(
  category: EventCategory,
  data: string,
  overrides?: Partial<Omit<TrackedEvent, "id">>,
): Omit<TrackedEvent, "id"> {
  return {
    sessionId: "test-session",
    category,
    data,
    priority: "medium",
    source: "tool_result",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("EventStore", () => {
  test("schema creation on init", () => {
    // If init succeeded without throwing, schema was created
    const events = store.getEvents("test-session");
    expect(events).toEqual([]);
  });

  test("writeEvent persists and is queryable", () => {
    store.writeEvent(event("file", '{"op":"read","path":"/test.ts"}'));
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("file");
    expect(events[0].data).toBe('{"op":"read","path":"/test.ts"}');
  });

  test("writeEvents writes multiple in single transaction", () => {
    store.writeEvents([
      event("file", '{"op":"read"}'),
      event("git", '{"op":"commit"}'),
      event("error", '{"msg":"fail"}', { priority: "critical" }),
    ]);
    const events = store.getEvents("test-session");
    expect(events).toHaveLength(3);
  });

  test("getEvents filters by category", () => {
    store.writeEvents([
      event("file", "a"),
      event("git", "b"),
      event("file", "c"),
    ]);
    const files = store.getEvents("test-session", { categories: ["file"] });
    expect(files).toHaveLength(2);
    expect(files.every((e) => e.category === "file")).toBe(true);
  });

  test("getEvents filters by priority", () => {
    store.writeEvents([
      event("file", "a", { priority: "low" }),
      event("error", "b", { priority: "critical" }),
    ]);
    const critical = store.getEvents("test-session", { priority: "critical" });
    expect(critical).toHaveLength(1);
    expect(critical[0].category).toBe("error");
  });

  test("getEvents filters by since timestamp", () => {
    const old = event("file", "old", { timestamp: 1000 });
    const recent = event("file", "recent", { timestamp: 2000 });
    store.writeEvents([old, recent]);
    const events = store.getEvents("test-session", { since: 1500 });
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("recent");
  });

  test("getEvents respects limit", () => {
    store.writeEvents([event("file", "a"), event("file", "b"), event("file", "c")]);
    const events = store.getEvents("test-session", { limit: 2 });
    expect(events).toHaveLength(2);
  });

  test("searchEvents uses FTS5", () => {
    store.writeEvents([
      event("file", '{"op":"read","path":"/src/utils/parser.ts"}'),
      event("file", '{"op":"write","path":"/src/index.ts"}'),
      event("git", '{"op":"commit","message":"fix parser bug"}'),
    ]);
    const results = store.searchEvents("test-session", "parser");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((e) => e.data.includes("parser"))).toBe(true);
  });

  test("getEventCounts returns correct counts", () => {
    store.writeEvents([
      event("file", "a"), event("file", "b"),
      event("git", "c"),
      event("error", "d"),
    ]);
    const counts = store.getEventCounts("test-session");
    expect(counts.file).toBe(2);
    expect(counts.git).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.cwd).toBe(0);
  });

  test("pruneEvents deletes old events", () => {
    store.writeEvents([
      event("file", "old", { timestamp: 1000 }),
      event("file", "recent", { timestamp: 9999 }),
    ]);
    const pruned = store.pruneEvents(5000);
    expect(pruned).toBe(1);
    const remaining = store.getEvents("test-session");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].data).toBe("recent");
  });

  test("isolates events by session", () => {
    store.writeEvent(event("file", "session-a", { sessionId: "a" }));
    store.writeEvent(event("file", "session-b", { sessionId: "b" }));
    expect(store.getEvents("a")).toHaveLength(1);
    expect(store.getEvents("b")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/event-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/event-store.ts
import { Database } from "bun:sqlite";

/** Event categories extracted from tool results */
export type EventCategory =
  | "file"
  | "git"
  | "error"
  | "task"
  | "cwd"
  | "mcp"
  | "subagent"
  | "prompt"
  | "decision";

/** Priority levels for resume snapshot ordering */
export type EventPriority = "critical" | "high" | "medium" | "low";

/** A tracked event */
export interface TrackedEvent {
  id?: number;
  sessionId: string;
  category: EventCategory;
  data: string;
  priority: EventPriority;
  source: string;
  timestamp: number;
}

const SCHEMA = `
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

CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
  data,
  content=session_events,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON session_events BEGIN
  INSERT INTO session_events_fts(rowid, data) VALUES (new.id, new.data);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON session_events BEGIN
  INSERT INTO session_events_fts(session_events_fts, rowid, data) VALUES ('delete', old.id, old.data);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON session_events BEGIN
  INSERT INTO session_events_fts(session_events_fts, rowid, data) VALUES ('delete', old.id, old.data);
  INSERT INTO session_events_fts(rowid, data) VALUES (new.id, new.data);
END;
`;

const ALL_CATEGORIES: EventCategory[] = [
  "file", "git", "error", "task", "cwd", "mcp", "subagent", "prompt", "decision",
];

export class EventStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  init(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  writeEvent(event: Omit<TrackedEvent, "id">): void {
    this.db.run(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      [event.sessionId, event.category, event.data, event.priority, event.source, event.timestamp],
    );
  }

  writeEvents(events: Omit<TrackedEvent, "id">[]): void {
    const insert = this.db.prepare(
      "INSERT INTO session_events (session_id, category, data, priority, source, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const event of events) {
        insert.run(event.sessionId, event.category, event.data, event.priority, event.source, event.timestamp);
      }
    });
    tx();
  }

  getEvents(
    sessionId: string,
    filters?: {
      categories?: EventCategory[];
      priority?: EventPriority;
      since?: number;
      limit?: number;
    },
  ): TrackedEvent[] {
    const conditions = ["session_id = ?"];
    const params: (string | number)[] = [sessionId];

    if (filters?.categories?.length) {
      conditions.push(`category IN (${filters.categories.map(() => "?").join(",")})`);
      params.push(...filters.categories);
    }
    if (filters?.priority) {
      conditions.push("priority = ?");
      params.push(filters.priority);
    }
    if (filters?.since) {
      conditions.push("timestamp > ?");
      params.push(filters.since);
    }

    let sql = `SELECT id, session_id AS sessionId, category, data, priority, source, timestamp FROM session_events WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC`;

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as TrackedEvent[];
  }

  searchEvents(sessionId: string, query: string, limit = 20): TrackedEvent[] {
    const sql = `
      SELECT e.id, e.session_id AS sessionId, e.category, e.data, e.priority, e.source, e.timestamp
      FROM session_events_fts fts
      JOIN session_events e ON e.id = fts.rowid
      WHERE fts.data MATCH ? AND e.session_id = ?
      ORDER BY rank
      LIMIT ?
    `;
    return this.db.prepare(sql).all(query, sessionId, limit) as TrackedEvent[];
  }

  getEventCounts(sessionId: string): Record<EventCategory, number> {
    const rows = this.db.prepare(
      "SELECT category, COUNT(*) AS count FROM session_events WHERE session_id = ? GROUP BY category",
    ).all(sessionId) as Array<{ category: EventCategory; count: number }>;

    const counts = {} as Record<EventCategory, number>;
    for (const cat of ALL_CATEGORIES) counts[cat] = 0;
    for (const row of rows) counts[row.category] = row.count;
    return counts;
  }

  pruneEvents(olderThan: number): number {
    const stmt = this.db.prepare("DELETE FROM session_events WHERE timestamp < ?");
    const result = stmt.run(olderThan);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/event-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-mode/event-store.ts tests/context-mode/event-store.test.ts
git commit -m "feat(context-mode): add SQLite event store with FTS5 search"
```

---

### Task 8: Create event extractor [sequential: depends on 7]

**Files:**
- Create: `src/context-mode/event-extractor.ts`
- Create: `tests/context-mode/event-extractor.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/event-extractor.test.ts
import { extractEvents, extractPromptEvents } from "../../src/context-mode/event-extractor.js";

const SESSION_ID = "test-session";

describe("extractEvents", () => {
  describe("general error rule", () => {
    test("emits error event for any tool with isError=true", () => {
      const event = {
        type: "tool_result",
        toolName: "read",
        toolCallId: "id",
        input: { path: "/test.ts" },
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
        details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "error")).toBe(true);
      const errEvent = events.find((e) => e.category === "error")!;
      expect(errEvent.priority).toBe("critical");
      expect(errEvent.data).toContain("read");
    });
  });

  describe("bash extraction", () => {
    test("git command emits git event", () => {
      const event = {
        type: "tool_result", toolName: "bash", toolCallId: "id",
        input: { command: "git commit -m 'fix'" },
        content: [{ type: "text", text: "1 file changed" }],
        isError: false,
        details: { exitCode: 0 },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "git")).toBe(true);
    });

    test("non-zero exit emits error event", () => {
      const event = {
        type: "tool_result", toolName: "bash", toolCallId: "id",
        input: { command: "npm test" },
        content: [{ type: "text", text: "FAILED" }],
        isError: false,
        details: { exitCode: 1 },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "error")).toBe(true);
    });

    test("cd command emits cwd event", () => {
      const event = {
        type: "tool_result", toolName: "bash", toolCallId: "id",
        input: { command: "cd /project && ls" },
        content: [{ type: "text", text: "file1 file2" }],
        isError: false,
        details: { exitCode: 0 },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "cwd")).toBe(true);
    });
  });

  describe("read extraction", () => {
    test("emits file event with read op", () => {
      const event = {
        type: "tool_result", toolName: "read", toolCallId: "id",
        input: { path: "/src/index.ts" },
        content: [{ type: "text", text: "export default {}" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("read");
      expect(data.path).toBe("/src/index.ts");
    });
  });

  describe("edit extraction", () => {
    test("emits file event with edit op at high priority", () => {
      const event = {
        type: "tool_result", toolName: "edit", toolCallId: "id",
        input: { path: "/src/types.ts" },
        content: [{ type: "text", text: "edited" }],
        isError: false, details: { path: "/src/types.ts" },
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      expect(events[0].priority).toBe("high");
    });
  });

  describe("write extraction", () => {
    test("emits file event with write op from input", () => {
      const event = {
        type: "tool_result", toolName: "write", toolCallId: "id",
        input: { path: "/new-file.ts", content: "hello" },
        content: [{ type: "text", text: "written" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("write");
      expect(data.path).toBe("/new-file.ts");
    });
  });

  describe("grep extraction", () => {
    test("emits file event with search op", () => {
      const event = {
        type: "tool_result", toolName: "grep", toolCallId: "id",
        input: { pattern: "TODO", path: "src/" },
        content: [{ type: "text", text: "src/a.ts:1:TODO fix" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("search");
    });
  });

  describe("find extraction", () => {
    test("emits file event with find op", () => {
      const event = {
        type: "tool_result", toolName: "find", toolCallId: "id",
        input: { pattern: "*.ts" },
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events[0].category).toBe("file");
      const data = JSON.parse(events[0].data);
      expect(data.op).toBe("find");
    });
  });

  describe("custom tool extraction", () => {
    test("todo_write emits task event", () => {
      const event = {
        type: "tool_result", toolName: "todo_write", toolCallId: "id",
        input: { ops: [{ op: "add_task", content: "Fix bug" }] },
        content: [{ type: "text", text: "ok" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "task")).toBe(true);
    });

    test("ctx_* tools emit mcp event", () => {
      const event = {
        type: "tool_result", toolName: "ctx_execute", toolCallId: "id",
        input: { code: "ls" },
        content: [{ type: "text", text: "output" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "mcp")).toBe(true);
    });

    test("sub-agent dispatch tools emit subagent event", () => {
      const event = {
        type: "tool_result", toolName: "task", toolCallId: "id",
        input: { assignment: "fix the bug" },
        content: [{ type: "text", text: "done" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events.some((e) => e.category === "subagent")).toBe(true);
    });

    test("unknown custom tools return empty array", () => {
      const event = {
        type: "tool_result", toolName: "unknown_tool", toolCallId: "id",
        input: {},
        content: [{ type: "text", text: "x" }],
        isError: false, details: undefined,
      } as any;
      const events = extractEvents(event, SESSION_ID);
      expect(events).toHaveLength(0);
    });
  });
});

describe("extractPromptEvents", () => {
  test("emits prompt event for any prompt", () => {
    const events = extractPromptEvents("show me the code", SESSION_ID);
    expect(events.some((e) => e.category === "prompt")).toBe(true);
  });

  test("emits decision event for directive language", () => {
    const events = extractPromptEvents("let's go with option A", SESSION_ID);
    expect(events.some((e) => e.category === "decision")).toBe(true);
  });

  test("does not emit decision for non-directive prompt", () => {
    const events = extractPromptEvents("what does this function do?", SESSION_ID);
    expect(events.every((e) => e.category !== "decision")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/event-extractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/event-extractor.ts
import type { EventCategory, EventPriority, TrackedEvent } from "./event-store.js";

type Event = Omit<TrackedEvent, "id">;

const GIT_COMMAND_PATTERNS = [
  /^git\s+(commit|merge|rebase|checkout|switch|branch|push|pull|stash|reset|cherry-pick|tag)\b/,
];

const DECISION_PATTERNS = [
  /\blet'?s?\s+go\s+with\b/i,
  /\buse\s+\S+\s+instead\s+of\b/i,
  /\bi\s+want\b/i,
  /\bgo\s+ahead\b/i,
  /^(yes|no|yep|nope|sure|ok|okay)\b/i,
  /\bdo\s+that\b/i,
  /\blet'?s?\s+do\b/i,
  /\bpick\s+(option|approach|choice)\b/i,
];

function makeEvent(
  sessionId: string,
  category: EventCategory,
  data: Record<string, unknown>,
  priority: EventPriority,
  source: string,
): Event {
  return {
    sessionId,
    category,
    data: JSON.stringify(data),
    priority,
    source,
    timestamp: Date.now(),
  };
}

function getTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n")
    .slice(0, 500); // Cap for storage
}

/** Extract events from a tool result */
export function extractEvents(
  event: {
    toolName: string;
    input: Record<string, unknown>;
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
    details: unknown;
  },
  sessionId: string,
): Event[] {
  const events: Event[] = [];
  const text = getTextContent(event.content);

  // General rule: emit error event for any isError result
  if (event.isError) {
    events.push(makeEvent(sessionId, "error", {
      toolName: event.toolName,
      content: text,
    }, "critical", "tool_result"));
  }

  switch (event.toolName) {
    case "bash":
      extractBash(events, event, sessionId, text);
      break;
    case "read":
      extractFile(events, event, sessionId, "read");
      break;
    case "edit":
      extractFile(events, event, sessionId, "edit", "high");
      break;
    case "write":
      extractFile(events, event, sessionId, "write", "high");
      break;
    case "grep":
      extractFile(events, event, sessionId, "search");
      break;
    case "find":
      extractFile(events, event, sessionId, "find");
      break;
    case "todo_write":
      events.push(makeEvent(sessionId, "task", {
        input: event.input,
      }, "high", "tool_result"));
      break;
    default:
      if (event.toolName.startsWith("ctx_")) {
        events.push(makeEvent(sessionId, "mcp", {
          tool: event.toolName,
        }, "low", "tool_result"));
      } else if (event.toolName === "task" || event.toolName === "sub_agent") {
        events.push(makeEvent(sessionId, "subagent", {
          toolName: event.toolName,
          input: event.input,
        }, "medium", "tool_result"));
      }
      // Unknown tools: no events
      break;
  }

  return events;
}

function extractBash(
  events: Event[],
  event: { input: Record<string, unknown>; details: unknown },
  sessionId: string,
  text: string,
): void {
  const command = typeof event.input.command === "string" ? event.input.command : "";
  const exitCode = event.details && typeof event.details === "object" && "exitCode" in event.details
    ? (event.details as { exitCode: number }).exitCode
    : 0;

  // Git operations
  if (GIT_COMMAND_PATTERNS.some((p) => p.test(command))) {
    events.push(makeEvent(sessionId, "git", {
      command,
      output: text,
    }, "high", "tool_result"));
  }

  // Non-zero exit (in addition to general isError rule)
  if (exitCode !== 0) {
    events.push(makeEvent(sessionId, "error", {
      command,
      exitCode,
      output: text,
    }, "critical", "tool_result"));
  }

  // Working directory change
  if (/\bcd\s+/.test(command)) {
    events.push(makeEvent(sessionId, "cwd", {
      command,
    }, "low", "tool_result"));
  }
}

function extractFile(
  events: Event[],
  event: { input: Record<string, unknown> },
  sessionId: string,
  op: string,
  priority: EventPriority = "medium",
): void {
  const path = typeof event.input.path === "string" ? event.input.path : "unknown";
  events.push(makeEvent(sessionId, "file", { op, path }, priority, "tool_result"));
}

/** Extract events from a user prompt (called from before_agent_start handler) */
export function extractPromptEvents(prompt: string, sessionId: string): Event[] {
  const events: Event[] = [];

  // Always capture the prompt
  events.push(makeEvent(sessionId, "prompt", { prompt }, "high", "before_agent_start"));

  // Check for decision patterns
  if (DECISION_PATTERNS.some((p) => p.test(prompt))) {
    events.push(makeEvent(sessionId, "decision", { prompt }, "high", "before_agent_start"));
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/event-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-mode/event-extractor.ts tests/context-mode/event-extractor.test.ts
git commit -m "feat(context-mode): add event extractor for all tool types + prompt analysis"
```

---

### Task 9: Wire event tracking into hooks [sequential: depends on 5, 7, 8]

**Files:**
- Modify: `src/context-mode/hooks.ts`
- Modify: `tests/context-mode/hooks.test.ts`

- [ ] **Step 1: Add event tracking tests**

Append to `tests/context-mode/hooks.test.ts`:

```typescript
// Additional tests for Phase 2 event tracking
// (These verify the hooks call event extraction and store writes)

test("tool_result handler extracts and stores events when eventTracking enabled", () => {
  const pi = createMockPi();
  registerContextModeHooks(pi, DEFAULT_CONFIG);

  const handler = pi._handlers.get("tool_result");
  const event = {
    type: "tool_result",
    toolName: "read",
    toolCallId: "test-id",
    input: { path: "/src/test.ts" },
    content: [{ type: "text", text: "content" }],
    isError: false,
    details: undefined,
  };

  // Handler should not throw even without event store initialized
  // (event tracking is fire-and-forget)
  expect(() => handler(event, {})).not.toThrow();
});
```

- [ ] **Step 2: Extend hooks.ts to call event extraction**

In `src/context-mode/hooks.ts`, import event modules:

```typescript
import { EventStore } from "./event-store.js";
import { extractEvents, extractPromptEvents } from "./event-extractor.js";
import { mkdirSync } from "node:fs";
```

Add event store initialization in `registerContextModeHooks()`:

```typescript
let eventStore: EventStore | null = null;
let sessionId = `session-${Date.now()}`;

if (config.contextMode.eventTracking) {
  try {
    const dbDir = join(process.cwd(), ".omp", "supipowers", "sessions");
    mkdirSync(dbDir, { recursive: true });
    eventStore = new EventStore(join(dbDir, "events.db"));
    eventStore.init();
  } catch (e) {
    pi.logger.error("context-mode: failed to initialize event store", e);
  }
}
```

Extend the `tool_result` handler:

```typescript
pi.on("tool_result", (event) => {
  // Phase 1: compression
  const compressed = compressToolResult(event, config.contextMode.compressionThreshold);

  // Phase 2: event extraction (fire-and-forget)
  if (eventStore && config.contextMode.eventTracking) {
    try {
      const events = extractEvents(event, sessionId);
      if (events.length > 0) eventStore.writeEvents(events);
    } catch (e) {
      pi.logger.warn("context-mode: event extraction failed", e);
    }
  }

  return compressed;
});
```

Extend the `before_agent_start` handler to capture prompts:

```typescript
// Inside before_agent_start handler, after routing logic:
if (eventStore && config.contextMode.eventTracking) {
  try {
    const prompt = (event as any).prompt as string | undefined;
    if (prompt) {
      const events = extractPromptEvents(prompt, sessionId);
      if (events.length > 0) eventStore.writeEvents(events);
    }
  } catch (e) {
    pi.logger.warn("context-mode: prompt capture failed", e);
  }
}
```

Add `session_start` handler:

```typescript
pi.on("session_start", () => {
  sessionId = `session-${Date.now()}`;
  cachedStatus = null; // re-detect on new session
});
```

Export eventStore accessor for Phase 3:

```typescript
export function _getEventStore(): EventStore | null {
  return eventStore;
}

export function _getSessionId(): string {
  return sessionId;
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/context-mode/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/context-mode/hooks.ts tests/context-mode/hooks.test.ts
git commit -m "feat(context-mode): wire event tracking into tool_result and before_agent_start hooks"
```

---

## Chunk 4: Phase 3, 4, and 5

### Task 10: Create snapshot builder [sequential: depends on 7]

**Files:**
- Create: `src/context-mode/snapshot-builder.ts`
- Create: `tests/context-mode/snapshot-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/snapshot-builder.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore } from "../../src/context-mode/event-store.js";
import { buildResumeSnapshot } from "../../src/context-mode/snapshot-builder.js";

let tmpDir: string;
let store: EventStore;
const SESSION = "test-session";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-snapshot-"));
  store = new EventStore(path.join(tmpDir, "events.db"));
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvent(category: string, data: Record<string, unknown>, priority = "medium") {
  store.writeEvent({
    sessionId: SESSION,
    category: category as any,
    data: JSON.stringify(data),
    priority: priority as any,
    source: "test",
    timestamp: Date.now(),
  });
}

describe("buildResumeSnapshot", () => {
  test("returns empty string for empty event store", () => {
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toBe("");
  });

  test("includes last_request from most recent prompt", () => {
    writeEvent("prompt", { prompt: "fix the bug in parser.ts" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<last_request>");
    expect(snapshot).toContain("fix the bug in parser.ts");
  });

  test("includes pending_tasks from task events", () => {
    writeEvent("task", { input: { ops: [{ op: "add_task", content: "Refactor utils" }] } }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<pending_tasks>");
    expect(snapshot).toContain("Refactor utils");
  });

  test("includes files_modified from file write/edit events", () => {
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, "high");
    writeEvent("file", { op: "write", path: "/src/new.ts" }, "high");
    writeEvent("file", { op: "read", path: "/src/old.ts" }); // reads excluded
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<files_modified>");
    expect(snapshot).toContain("/src/types.ts");
    expect(snapshot).toContain("/src/new.ts");
    expect(snapshot).not.toContain("/src/old.ts");
  });

  test("includes recent_errors", () => {
    writeEvent("error", { command: "npm test", exitCode: 1, output: "FAIL" }, "critical");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<recent_errors>");
    expect(snapshot).toContain("npm test");
  });

  test("includes git_state", () => {
    writeEvent("git", { command: "git commit -m 'fix'", output: "1 file changed" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<git_state>");
    expect(snapshot).toContain("git commit");
  });

  test("omits sections with no events", () => {
    writeEvent("prompt", { prompt: "hello" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<last_request>");
    expect(snapshot).not.toContain("<pending_tasks>");
    expect(snapshot).not.toContain("<files_modified>");
    expect(snapshot).not.toContain("<recent_errors>");
    expect(snapshot).not.toContain("<git_state>");
  });

  test("output is under 2KB for large event sets", () => {
    for (let i = 0; i < 100; i++) {
      writeEvent("file", { op: "edit", path: `/src/file${i}.ts` }, "high");
      writeEvent("error", { command: `cmd${i}`, output: "x".repeat(100) }, "critical");
    }
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThan(2048);
  });

  test("deduplicates file paths", () => {
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, "high");
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    const matches = snapshot.match(/\/src\/types\.ts/g);
    expect(matches).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/snapshot-builder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/snapshot-builder.ts
import type { EventStore, TrackedEvent } from "./event-store.js";

const CAPS = {
  tasks: 10,
  decisions: 5,
  files: 20,
  errors: 3,
  git: 5,
};

/** Build a resume snapshot from tracked events for a session */
export function buildResumeSnapshot(eventStore: EventStore, sessionId: string): string {
  const counts = eventStore.getEventCounts(sessionId);
  const hasAnyEvents = Object.values(counts).some((c) => c > 0);
  if (!hasAnyEvents) return "";

  const sections: string[] = ["<session_knowledge>"];

  // Last request
  const prompts = eventStore.getEvents(sessionId, { categories: ["prompt"], limit: 1 });
  if (prompts.length > 0) {
    const data = safeParse(prompts[0].data);
    const prompt = typeof data?.prompt === "string" ? data.prompt.slice(0, 200) : "";
    if (prompt) {
      sections.push(`  <last_request>${prompt}</last_request>`);
    }
  }

  // Pending tasks
  const tasks = eventStore.getEvents(sessionId, { categories: ["task"], limit: CAPS.tasks });
  if (tasks.length > 0) {
    sections.push("  <pending_tasks>");
    for (const t of tasks) {
      const data = safeParse(t.data);
      const content = extractTaskContent(data);
      if (content) sections.push(`    - ${content.slice(0, 100)}`);
    }
    sections.push("  </pending_tasks>");
  }

  // Key decisions
  const decisions = eventStore.getEvents(sessionId, { categories: ["decision"], limit: CAPS.decisions });
  if (decisions.length > 0) {
    sections.push("  <key_decisions>");
    for (const d of decisions) {
      const data = safeParse(d.data);
      const prompt = typeof data?.prompt === "string" ? data.prompt.slice(0, 100) : "";
      if (prompt) sections.push(`    - ${prompt}`);
    }
    sections.push("  </key_decisions>");
  }

  // Files modified (write/edit only, deduplicated)
  const fileEvents = eventStore.getEvents(sessionId, { categories: ["file"], limit: 200 });
  const modifiedPaths = new Set<string>();
  for (const f of fileEvents) {
    const data = safeParse(f.data);
    if (data?.op === "edit" || data?.op === "write") {
      if (typeof data.path === "string") modifiedPaths.add(data.path);
    }
  }
  if (modifiedPaths.size > 0) {
    sections.push("  <files_modified>");
    const paths = [...modifiedPaths].slice(0, CAPS.files);
    for (const p of paths) sections.push(`    - ${p}`);
    sections.push("  </files_modified>");
  }

  // Recent errors
  const errors = eventStore.getEvents(sessionId, { categories: ["error"], limit: CAPS.errors });
  if (errors.length > 0) {
    sections.push("  <recent_errors>");
    for (const e of errors) {
      const data = safeParse(e.data);
      const summary = formatErrorSummary(data);
      if (summary) sections.push(`    - ${summary.slice(0, 150)}`);
    }
    sections.push("  </recent_errors>");
  }

  // Git state
  const gitEvents = eventStore.getEvents(sessionId, { categories: ["git"], limit: CAPS.git });
  if (gitEvents.length > 0) {
    sections.push("  <git_state>");
    for (const g of gitEvents) {
      const data = safeParse(g.data);
      const cmd = typeof data?.command === "string" ? data.command.slice(0, 100) : "";
      if (cmd) sections.push(`    - ${cmd}`);
    }
    sections.push("  </git_state>");
  }

  sections.push("</session_knowledge>");

  // If only the wrapper tags exist (no inner sections), return empty
  if (sections.length <= 2) return "";

  return sections.join("\n");
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractTaskContent(data: Record<string, unknown> | null): string | null {
  if (!data?.input) return null;
  const input = data.input as Record<string, unknown>;
  if (Array.isArray(input.ops)) {
    const ops = input.ops as Array<{ content?: string; op?: string }>;
    return ops.map((o) => `${o.op ?? "task"}: ${o.content ?? ""}`).join("; ");
  }
  return JSON.stringify(input).slice(0, 100);
}

function formatErrorSummary(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const command = typeof data.command === "string" ? data.command : "";
  const toolName = typeof data.toolName === "string" ? data.toolName : "";
  const exitCode = typeof data.exitCode === "number" ? ` (exit ${data.exitCode})` : "";
  const prefix = command || toolName;
  return prefix ? `${prefix}${exitCode}` : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/snapshot-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-mode/snapshot-builder.ts tests/context-mode/snapshot-builder.test.ts
git commit -m "feat(context-mode): add snapshot builder for compaction resume"
```

---

### Task 11: Wire compaction hooks (Phase 3) [sequential: depends on 9, 10]

**Files:**
- Modify: `src/context-mode/hooks.ts`
- Modify: `tests/context-mode/hooks.test.ts`

- [ ] **Step 1: Add compaction hook registration**

In `src/context-mode/hooks.ts`, inside `registerContextModeHooks()`, add after the Phase 2 wiring:

```typescript
// Phase 3: Compaction integration
if (config.contextMode.compaction && eventStore) {
  let pendingSnapshot: string | null = null;

  pi.on("session_before_compact", () => {
    try {
      pendingSnapshot = buildResumeSnapshot(eventStore!, sessionId);
    } catch (e) {
      pi.logger.warn("context-mode: snapshot build failed", e);
      pendingSnapshot = null;
    }
    return undefined; // don't cancel or replace compaction
  });

  pi.on("session.compacting", () => {
    if (!pendingSnapshot) return undefined;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    return {
      context: snapshot.split("\n"),
      preserveData: {
        resumeSnapshot: snapshot,
        eventCounts: eventStore!.getEventCounts(sessionId),
      },
    };
  });
}
```

Add import:
```typescript
import { buildResumeSnapshot } from "./snapshot-builder.js";
```

- [ ] **Step 2: Add compaction hook tests**

Append to `tests/context-mode/hooks.test.ts`:

```typescript
  test("registers compaction hooks when compaction enabled", () => {
    const pi = createMockPi();
    registerContextModeHooks(pi, DEFAULT_CONFIG);
    const events = pi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_before_compact");
    expect(events).toContain("session.compacting");
  });

  test("does not register compaction hooks when disabled", () => {
    const pi = createMockPi();
    const config = {
      ...DEFAULT_CONFIG,
      contextMode: { ...DEFAULT_CONFIG.contextMode, compaction: false },
    };
    registerContextModeHooks(pi, config);
    const events = pi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).not.toContain("session_before_compact");
    expect(events).not.toContain("session.compacting");
  });
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/context-mode/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/context-mode/hooks.ts tests/context-mode/hooks.test.ts
git commit -m "feat(context-mode): wire compaction hooks for session knowledge injection"
```

---

### Task 12: Add LLM summarization (Phase 4) [sequential: depends on 3]

**Files:**
- Modify: `src/context-mode/compressor.ts`
- Modify: `src/context-mode/hooks.ts`

- [ ] **Step 1: Add async compressor function**

In `src/context-mode/compressor.ts`, add:

```typescript
/** Summarization prompt templates by tool type */
const SUMMARIZE_PROMPTS: Record<string, string> = {
  bash: "Summarize this command output. Preserve: exit code, key findings, error messages, file paths mentioned. Be concise (under 200 words).",
  read: "Summarize this file content. Preserve: file structure, key exports/functions, notable patterns. Be concise (under 200 words).",
  grep: "Summarize these search results. Preserve: match count, most relevant matches, file distribution. Be concise (under 200 words).",
  find: "Summarize these file paths. Preserve: directory structure, file count, key patterns. Be concise (under 200 words).",
};

/** Compress with optional LLM summarization for very large outputs */
export async function compressToolResultWithLLM(
  event: ToolResultEventLike,
  threshold: number,
  llmThreshold: number,
  summarize: (text: string, toolName: string) => Promise<string>,
): Promise<ToolResultEventResult | undefined> {
  // General rules
  if (event.isError) return undefined;
  if (hasNonTextContent(event.content)) return undefined;
  const byteSize = measureTextBytes(event.content);
  if (byteSize <= threshold) return undefined;

  const text = getCombinedText(event.content);

  // Below LLM threshold: use structural compression
  if (byteSize < llmThreshold) {
    return compressToolResult(event, threshold);
  }

  // Above LLM threshold: try LLM summarization
  try {
    const prompt = SUMMARIZE_PROMPTS[event.toolName] ?? "Summarize this output concisely (under 200 words).";
    const summary = await summarize(`${prompt}\n\n${text}`, event.toolName);

    // Validate: non-empty and reasonably sized
    if (summary && summary.length >= 50) {
      return { content: [{ type: "text", text: summary }] };
    }
  } catch {
    // Fall through to structural compression
  }

  // Fallback
  return compressToolResult(event, threshold);
}
```

- [ ] **Step 2: Update hooks to use LLM compressor when configured**

In `src/context-mode/hooks.ts`, update the `tool_result` handler:

```typescript
import { compressToolResult, compressToolResultWithLLM } from "./compressor.js";

// In the tool_result handler:
pi.on("tool_result", async (event, ctx) => {
  let compressed;

  if (config.contextMode.llmSummarization) {
    const summarize = async (text: string, _toolName: string) => {
      // Use pi.exec or direct API call for summarization
      // For now, this requires context-mode or a configured model
      const result = await pi.exec("echo", ["LLM summarization not yet wired"]);
      return result.stdout;
    };
    compressed = await compressToolResultWithLLM(
      event,
      config.contextMode.compressionThreshold,
      config.contextMode.llmThreshold,
      summarize,
    );
  } else {
    compressed = compressToolResult(event, config.contextMode.compressionThreshold);
  }

  // Phase 2: event extraction (fire-and-forget)
  if (eventStore && config.contextMode.eventTracking) {
    try {
      const events = extractEvents(event, sessionId);
      if (events.length > 0) eventStore.writeEvents(events);
    } catch (e) {
      pi.logger.warn("context-mode: event extraction failed", e);
    }
  }

  return compressed;
});
```

Note: The `summarize` function is a stub. The actual LLM call implementation depends on how OMP exposes model API access to extensions. The interface is correct — the implementation will be connected when the model API is available.

- [ ] **Step 3: Run tests**

Run: `bun test tests/context-mode/`
Expected: PASS (LLM path not exercised in tests since it's off by default)

- [ ] **Step 4: Commit**

```bash
git add src/context-mode/compressor.ts src/context-mode/hooks.ts
git commit -m "feat(context-mode): add LLM summarization path (Phase 4, off by default)"
```

---

### Task 13: Create installer (Phase 5) [parallel-safe]

**Files:**
- Create: `src/context-mode/installer.ts`
- Create: `tests/context-mode/installer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/context-mode/installer.test.ts
import { checkInstallation, installContextMode } from "../../src/context-mode/installer.js";

describe("checkInstallation", () => {
  test("detects CLI installed", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "/usr/local/bin/context-mode", code: 0 });
    const status = await checkInstallation(exec, ["ctx_execute"]);
    expect(status.cliInstalled).toBe(true);
    expect(status.toolsAvailable).toBe(true);
  });

  test("detects CLI not installed", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", code: 1 });
    const status = await checkInstallation(exec, []);
    expect(status.cliInstalled).toBe(false);
    expect(status.toolsAvailable).toBe(false);
  });

  test("reports version when available", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "/usr/local/bin/context-mode", code: 0 })
      .mockResolvedValueOnce({ stdout: "1.2.3\n", code: 0 });
    const status = await checkInstallation(exec, []);
    expect(status.version).toBe("1.2.3");
  });

  test("handles version check failure", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: "/usr/local/bin/context-mode", code: 0 })
      .mockResolvedValueOnce({ stdout: "", code: 1 });
    const status = await checkInstallation(exec, []);
    expect(status.cliInstalled).toBe(true);
    expect(status.version).toBeNull();
  });
});

describe("installContextMode", () => {
  test("calls npm install -g", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "added 1 package", code: 0 });
    const result = await installContextMode(exec);
    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith("npm", ["install", "-g", "context-mode"]);
  });

  test("reports failure", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "", code: 1 });
    const result = await installContextMode(exec);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/context-mode/installer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/context-mode/installer.ts
import { detectContextMode } from "./detector.js";

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

/** Installation status */
export interface ContextModeInstallStatus {
  cliInstalled: boolean;
  mcpConfigured: boolean;
  toolsAvailable: boolean;
  version: string | null;
}

/** Check context-mode installation status */
export async function checkInstallation(
  exec: ExecFn,
  activeTools: string[],
): Promise<ContextModeInstallStatus> {
  const status = detectContextMode(activeTools);

  // Check CLI
  let cliInstalled = false;
  let version: string | null = null;

  try {
    const whichResult = await exec("which", ["context-mode"]);
    cliInstalled = whichResult.code === 0;
  } catch {
    cliInstalled = false;
  }

  // Get version
  if (cliInstalled) {
    try {
      const versionResult = await exec("context-mode", ["--version"]);
      if (versionResult.code === 0) {
        version = versionResult.stdout.trim() || null;
      }
    } catch {
      version = null;
    }
  }

  return {
    cliInstalled,
    mcpConfigured: status.available,
    toolsAvailable: status.available,
    version,
  };
}

/** Install context-mode globally */
export async function installContextMode(
  exec: ExecFn,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await exec("npm", ["install", "-g", "context-mode"]);
    if (result.code !== 0) {
      return {
        success: false,
        error: `npm install failed (exit ${result.code}). Check permissions or try: sudo npm install -g context-mode`,
      };
    }
    return { success: true };
  } catch (e) {
    return {
      success: false,
      error: `Installation failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/context-mode/installer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-mode/installer.ts tests/context-mode/installer.test.ts
git commit -m "feat(context-mode): add installer for context-mode CLI detection and installation"
```

---

### Task 14: Wire installer into /supi:config [sequential: depends on 13]

**Files:**
- Modify: `src/commands/config.ts`

- [ ] **Step 1: Add context-mode status section to config command**

In `src/commands/config.ts`, add imports:
```typescript
import { checkInstallation, installContextMode } from "../context-mode/installer.js";
```

Add a new function that displays context-mode status and offers installation. Call it from the main config handler after the existing settings display:

```typescript
async function showContextModeStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const status = await checkInstallation(
    (cmd, args) => pi.exec(cmd, args),
    pi.getActiveTools(),
  );

  const lines = [
    "",
    "Context Mode:",
    `  CLI installed: ${status.cliInstalled ? "\u2713" + (status.version ? ` v${status.version}` : "") : "\u2717"}",`
    `  MCP configured: ${status.mcpConfigured ? "\u2713" : "\u2717"}",`
    `  Tools available: ${status.toolsAvailable ? "\u2713" : "\u2717"}",`
  ];

  if (!status.mcpConfigured && status.cliInstalled) {
    lines.push("  \u2192 Run `omp mcp add context-mode` to enable");
  }

  ctx.ui.notify(lines.join("\n"), "info");

  if (!status.cliInstalled) {
    const install = await ctx.ui.confirm(
      "Install context-mode?",
      "context-mode reduces context window usage by compressing tool outputs.",
    );
    if (install) {
      ctx.ui.notify("Installing context-mode...", "info");
      const result = await installContextMode(
        (cmd, args) => pi.exec(cmd, args),
      );
      if (result.success) {
        ctx.ui.notify("context-mode installed. Configure MCP: omp mcp add context-mode", "info");
      } else {
        ctx.ui.notify(`Installation failed: ${result.error}`, "error");
      }
    }
  }
}
```

Call `showContextModeStatus(pi, ctx)` from the config command handler after showing the existing settings.

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/config.ts
git commit -m "feat(context-mode): add context-mode status to /supi:config"
```

---

### Task 15: Final integration test [sequential: depends on all]

**Files:**
- Modify: `tests/integration/extension.test.ts`

- [ ] **Step 1: Verify extension registration includes context-mode hooks**

Add to the existing integration test:

```typescript
test("registers context-mode hooks when enabled", () => {
  const mockPi = {
    registerCommand: vi.fn(),
    on: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    exec: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;

  supipowers(mockPi);

  // Verify context-mode hooks are registered
  const onCalls = mockPi.on.mock.calls.map((c: any[]) => c[0]);
  expect(onCalls).toContain("tool_result");
  expect(onCalls).toContain("tool_call");
  expect(onCalls).toContain("before_agent_start");
});
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add tests/integration/extension.test.ts
git commit -m "test: add context-mode integration test"
```
