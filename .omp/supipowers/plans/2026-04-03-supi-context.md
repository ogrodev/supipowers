# `/supi:context` Implementation Plan

**Goal:** Add a TUI-only `/supi:context` command that shows a breakdown of what's consuming the LLM context window — per-section system prompt sizes, active tool count, and overall token usage.

**Architecture:** Pure-function analyzer (`src/context/analyzer.ts`) handles all parsing and formatting. Thin command handler (`src/commands/context.ts`) calls the analyzer and renders via `ctx.ui.select()`. Bootstrap wiring follows existing TUI_COMMANDS pattern.

**Tech Stack:** TypeScript, Vitest, OMP ExtensionAPI

---

## Chunk 1: Core Analyzer — Pure Functions

### Task 1: `estimateTokens` and `formatSize` utilities

**Files:**
- Create: `src/context/analyzer.ts`
- Test: `tests/context/analyzer.test.ts`

- [ ] **Step 1: Write failing tests for `estimateTokens` and `formatSize`**

```typescript
// tests/context/analyzer.test.ts
import { describe, test, expect } from "vitest";
import { estimateTokens, formatSize } from "../../src/context/analyzer.js";

describe("estimateTokens", () => {
  test("returns chars / 4 ceiling for normal text", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → 3
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("handles single character", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("formatSize", () => {
  test("formats bytes to KB with 1 decimal for < 10KB", () => {
    expect(formatSize(5120)).toBe("5.0KB");
  });

  test("formats bytes to KB rounded for >= 10KB", () => {
    expect(formatSize(14336)).toBe("14KB");
  });

  test("returns 0KB for 0 bytes", () => {
    expect(formatSize(0)).toBe("0KB");
  });

  test("formats large values", () => {
    expect(formatSize(131072)).toBe("128KB");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/context/analyzer.ts

/** Estimate token count from text using chars/4 heuristic */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Format byte count as human-readable KB */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "0KB";
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)}KB`;
  return `${Math.round(kb)}KB`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/analyzer.ts tests/context/analyzer.test.ts
git commit -m "feat(context): add estimateTokens and formatSize utilities"
```

---

### Task 2: `parseSystemPrompt` — XML section extraction

**Files:**
- Modify: `src/context/analyzer.ts`
- Modify: `tests/context/analyzer.test.ts`

- [ ] **Step 1: Write failing tests for XML section parsing**

```typescript
// Add to tests/context/analyzer.test.ts
import { parseSystemPrompt } from "../../src/context/analyzer.js";
import type { PromptSection } from "../../src/context/analyzer.js";

describe("parseSystemPrompt", () => {
  test("returns empty array for empty string", () => {
    expect(parseSystemPrompt("")).toEqual([]);
  });

  test("extracts AGENTS.md file section", () => {
    const prompt = `Some preamble\n<file path="/project/AGENTS.md">\n# My Project\nSome content\n</file>\nSome postamble`;
    const sections = parseSystemPrompt(prompt);
    const agents = sections.find((s) => s.label === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.content).toContain("# My Project");
    expect(agents!.bytes).toBeGreaterThan(0);
  });

  test("extracts generic file sections by basename", () => {
    const prompt = `<file path="/project/src/types.ts">\nexport type Foo = string;\n</file>`;
    const sections = parseSystemPrompt(prompt);
    const fileSection = sections.find((s) => s.label === "File: types.ts");
    expect(fileSection).toBeDefined();
  });

  test("extracts skills section with count", () => {
    const prompt = `<skills>\n<skill name="planning">Plan content</skill>\n<skill name="review">Review content</skill>\n</skills>`;
    const sections = parseSystemPrompt(prompt);
    const skills = sections.find((s) => s.label === "Skills (2)");
    expect(skills).toBeDefined();
    expect(skills!.bytes).toBeGreaterThan(0);
  });

  test("extracts instructions section", () => {
    const prompt = `<instructions>\nDo this and that\n</instructions>`;
    const sections = parseSystemPrompt(prompt);
    expect(sections.find((s) => s.label === "Extension instructions")).toBeDefined();
  });

  test("extracts project section", () => {
    const prompt = `<project>\n## Context\nProject info\n</project>`;
    const sections = parseSystemPrompt(prompt);
    expect(sections.find((s) => s.label === "Project context")).toBeDefined();
  });

  test("collects unmatched text as Base system prompt", () => {
    const prompt = `You are a helpful assistant.\n<file path="/AGENTS.md">\ncontent\n</file>\nMore instructions here.`;
    const sections = parseSystemPrompt(prompt);
    const base = sections.find((s) => s.label === "Base system prompt");
    expect(base).toBeDefined();
    expect(base!.content).toContain("You are a helpful assistant.");
    expect(base!.content).toContain("More instructions here.");
  });

  test("returns single Base entry for prompt with no recognized sections", () => {
    const prompt = "Just a plain system prompt with no special sections.";
    const sections = parseSystemPrompt(prompt);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Base system prompt");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: FAIL — parseSystemPrompt not exported

- [ ] **Step 3: Write implementation**

```typescript
// Add to src/context/analyzer.ts

/** A parsed section of the system prompt */
export interface PromptSection {
  label: string;
  bytes: number;
  content: string;
}

/** Parse a system prompt into labeled sections */
export function parseSystemPrompt(text: string): PromptSection[] {
  if (!text) return [];

  const sections: PromptSection[] = [];
  const consumed = new Set<number>(); // track consumed character ranges

  // 1. Extract XML-like sections
  extractXmlSections(text, sections, consumed);

  // 2. Extract heading-based sections
  extractHeadingSections(text, sections, consumed);

  // 3. Collect remaining text as "Base system prompt"
  const base = collectUnconsumed(text, consumed);
  if (base.trim().length > 0) {
    sections.push({ label: "Base system prompt", bytes: byteLength(base), content: base });
  }

  return sections;
}

// ── Internal helpers ──────────────────────────────────────

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

function extractXmlSections(
  text: string,
  sections: PromptSection[],
  consumed: Set<number>,
): void {
  // Project section FIRST (so nested <file> tags inside <project> are consumed)
  const projMatch = text.match(/<project>([\s\S]*?)<\/project>/);
  if (projMatch) {
    sections.push({
      label: "Project context",
      bytes: byteLength(projMatch[0]),
      content: projMatch[0],
    });
    markConsumed(consumed, projMatch.index!, projMatch.index! + projMatch[0].length);
  }

  // Instructions section
  const instrMatch = text.match(/<instructions>([\s\S]*?)<\/instructions>/);
  if (instrMatch) {
    sections.push({
      label: "Extension instructions",
      bytes: byteLength(instrMatch[0]),
      content: instrMatch[0],
    });
    markConsumed(consumed, instrMatch.index!, instrMatch.index! + instrMatch[0].length);
  }

  // File sections — skip if already consumed (e.g., nested inside <project>)
  const fileRegex = /<file\s+path="([^"]*)">[\s\S]*?<\/file>/g;
  let match;
  while ((match = fileRegex.exec(text)) !== null) {
    if (consumed.has(match.index)) continue; // already inside <project>
    const filePath = match[1];
    const content = match[0];
    const label = filePath.toLowerCase().endsWith("agents.md")
      ? "AGENTS.md"
      : `File: ${filePath.split("/").pop() || filePath}`;
    sections.push({ label, bytes: byteLength(content), content });
    markConsumed(consumed, match.index, match.index + content.length);
  }

  // Skills section — try <skills> wrapper first, fall back to bare <skill> tags
  const skillsMatch = text.match(/<skills>([\s\S]*?)<\/skills>/);
  if (skillsMatch) {
    const content = skillsMatch[0];
    const skillCount = (skillsMatch[1].match(/<skill\s+name="/g) || []).length;
    sections.push({
      label: `Skills (${skillCount})`,
      bytes: byteLength(content),
      content,
    });
    markConsumed(consumed, skillsMatch.index!, skillsMatch.index! + content.length);
  } else {
    // Bare <skill> tags without wrapper
    const bareSkillRegex = /<skill\s+name="[^"]*">[\s\S]*?<\/skill>/g;
    let bareMatch;
    let skillContent = "";
    let skillCount = 0;
    while ((bareMatch = bareSkillRegex.exec(text)) !== null) {
      if (consumed.has(bareMatch.index)) continue;
      skillContent += bareMatch[0];
      skillCount++;
      markConsumed(consumed, bareMatch.index, bareMatch.index + bareMatch[0].length);
    }
    if (skillCount > 0) {
      sections.push({
        label: `Skills (${skillCount})`,
        bytes: byteLength(skillContent),
        content: skillContent,
      });
    }
  }
}

function extractHeadingSections(
  text: string,
  sections: PromptSection[],
  consumed: Set<number>,
): void {
  const headingPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /^# Memory Guidance\b/m, label: "Memory" },
    { pattern: /^# context-mode — MANDATORY routing rules\b/m, label: "Routing rules" },
    { pattern: /^## MCP Server Instructions\b/m, label: "MCP instructions" },
  ];

  for (const { pattern, label } of headingPatterns) {
    // Find all matches (routing rules may appear multiple times)
    const globalPattern = new RegExp(pattern.source, "gm");
    let merged = "";
    let match;
    while ((match = globalPattern.exec(text)) !== null) {
      if (consumed.has(match.index)) continue; // skip if inside an XML section
      // Capture from heading to next heading of same or higher level, or end
      const headingLevel = text[match.index] === "#" && text[match.index + 1] === "#" ? 2 : 1;
      const rest = text.slice(match.index + match[0].length);
      const nextHeading = rest.search(/^#{1,2}\s/m);
      const end = nextHeading === -1
        ? text.length
        : match.index + match[0].length + nextHeading;
      const content = text.slice(match.index, end);
      merged += content;
      markConsumed(consumed, match.index, end);
    }
    if (merged.length > 0) {
      sections.push({ label, bytes: byteLength(merged), content: merged });
    }
  }
}

function markConsumed(consumed: Set<number>, start: number, end: number): void {
  for (let i = start; i < end; i++) consumed.add(i);
}

function collectUnconsumed(text: string, consumed: Set<number>): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (!consumed.has(i)) result += text[i];
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/analyzer.ts tests/context/analyzer.test.ts
git commit -m "feat(context): add parseSystemPrompt with XML and heading extraction"
```

---

### Task 3: `parseSystemPrompt` — heading sections and edge cases

**Files:**
- Modify: `tests/context/analyzer.test.ts`

- [ ] **Step 1: Write additional tests for heading-based sections and edge cases**

```typescript
// Add to the parseSystemPrompt describe block in tests/context/analyzer.test.ts

test("extracts Memory section from heading", () => {
  const prompt = `Some text\n# Memory Guidance\nMemory root: memory://root\nSome memory content\n# Other Section\nOther content`;
  const sections = parseSystemPrompt(prompt);
  const memory = sections.find((s) => s.label === "Memory");
  expect(memory).toBeDefined();
  expect(memory!.content).toContain("Memory root: memory://root");
  expect(memory!.content).not.toContain("Other content");
});

test("extracts Routing rules section", () => {
  const prompt = `Preamble\n# context-mode — MANDATORY routing rules\nYou have context-mode MCP tools\n## Some subsection\nMore rules\n# Next Top Section\nDone`;
  const sections = parseSystemPrompt(prompt);
  const routing = sections.find((s) => s.label === "Routing rules");
  expect(routing).toBeDefined();
  expect(routing!.content).toContain("context-mode MCP tools");
});

test("extracts MCP instructions section", () => {
  const prompt = `Before\n## MCP Server Instructions\nThe following instructions\n## Another Section\nAfter`;
  const sections = parseSystemPrompt(prompt);
  const mcp = sections.find((s) => s.label === "MCP instructions");
  expect(mcp).toBeDefined();
  expect(mcp!.content).toContain("The following instructions");
  expect(mcp!.content).not.toContain("After");
});

test("merges duplicate routing rule blocks", () => {
  const prompt = `# context-mode — MANDATORY routing rules\nBlock 1\n# Other\nStuff\n# context-mode — MANDATORY routing rules\nBlock 2\n# End`;
  const sections = parseSystemPrompt(prompt);
  const routing = sections.filter((s) => s.label === "Routing rules");
  expect(routing).toHaveLength(1);
  expect(routing[0].content).toContain("Block 1");
  expect(routing[0].content).toContain("Block 2");
});

test("section bytes sum to total prompt bytes", () => {
  const prompt = `Preamble text\n<file path="/AGENTS.md">\nagent content\n</file>\n<skills>\n<skill name="a">skill a</skill>\n</skills>\n# Memory Guidance\nmemory stuff\n# Next\nTrailing`;
  const sections = parseSystemPrompt(prompt);
  // Spec requires: parsed section bytes must equal total prompt bytes exactly
  // (all unmatched text goes into Base system prompt)
  const totalSectionBytes = sections.reduce((sum, s) => sum + s.bytes, 0);
  const promptBytes = new TextEncoder().encode(prompt).length;
  expect(totalSectionBytes).toBe(promptBytes);
});

test("handles bare <skill> tags without <skills> wrapper", () => {
  const prompt = `Preamble\n<skill name="a">content a</skill>\n<skill name="b">content b</skill>\nPostamble`;
  const sections = parseSystemPrompt(prompt);
  const skills = sections.find((s) => s.label.startsWith("Skills"));
  expect(skills).toBeDefined();
  expect(skills!.label).toBe("Skills (2)");
});

test("does not double-count <file> nested inside <project>", () => {
  const prompt = `<project>\n<file path="/src/types.ts">\ntype Foo = string;\n</file>\n</project>`;
  const sections = parseSystemPrompt(prompt);
  // Should have Project context but NOT a separate File: types.ts
  expect(sections.find((s) => s.label === "Project context")).toBeDefined();
  expect(sections.find((s) => s.label === "File: types.ts")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they pass (these should pass with Task 2's implementation)**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: PASS — if any fail, adjust implementation

- [ ] **Step 3: Commit**

```bash
git add tests/context/analyzer.test.ts
git commit -m "test(context): add heading section and edge case tests for parseSystemPrompt"
```

---

### Task 4: `buildBreakdown` — format display lines

**Files:**
- Modify: `src/context/analyzer.ts`
- Modify: `tests/context/analyzer.test.ts`

- [ ] **Step 1: Write failing tests for `buildBreakdown`**

```typescript
// Add to tests/context/analyzer.test.ts
import { buildBreakdown } from "../../src/context/analyzer.js";

describe("buildBreakdown", () => {
  const sampleSections: PromptSection[] = [
    { label: "Base system prompt", bytes: 2048, content: "x".repeat(2048) },
    { label: "AGENTS.md", bytes: 4096, content: "x".repeat(4096) },
    { label: "Skills (2)", bytes: 8192, content: "x".repeat(8192) },
  ];

  test("builds display lines with full data", () => {
    const usage = { tokens: 50000, contextWindow: 200000, percent: 25 };
    const tools = ["read", "edit", "bash"];
    const lines = buildBreakdown(usage, sampleSections, tools);

    // Header should match spec format: "~50K / 200K tokens, 25%"
    expect(lines[0]).toBe("Context Breakdown (~50K / 200K tokens, 25%)");

    // Should contain section labels
    const joined = lines.join("\n");
    expect(joined).toContain("AGENTS.md");
    expect(joined).toContain("Skills (2)");
    expect(joined).toContain("Base system prompt");
    expect(joined).toContain("Tools: 3 active");
    expect(joined).toContain("Close");
  });

  test("builds display without usage data", () => {
    const lines = buildBreakdown(null, sampleSections, ["read"]);
    const joined = lines.join("\n");
    expect(joined).toContain("AGENTS.md");
    expect(joined).toContain("Tools: 1 active");
    expect(joined).not.toContain("undefined");
  });

  test("builds display without sections", () => {
    const usage = { tokens: 10000, contextWindow: 200000, percent: 5 };
    const lines = buildBreakdown(usage, [], ["read", "edit"]);
    const joined = lines.join("\n");
    expect(joined).toContain("10K");
    expect(joined).not.toContain("System Prompt");
    expect(joined).toContain("Tools: 2 active");
  });

  test("handles null token fields in usage", () => {
    const usage = { tokens: null, contextWindow: 200000, percent: null };
    const lines = buildBreakdown(usage as any, sampleSections, []);
    const joined = lines.join("\n");
    expect(joined).toContain("200K");
    expect(joined).not.toContain("null");
  });

  test("shows 'No system prompt captured' when prompt was empty", () => {
    const usage = { tokens: 10000, contextWindow: 200000, percent: 5 };
    const lines = buildBreakdown(usage, [], ["read"], true);
    const joined = lines.join("\n");
    expect(joined).toContain("No system prompt captured");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: FAIL — buildBreakdown not exported

- [ ] **Step 3: Write implementation**

```typescript
// Add to src/context/analyzer.ts

/** Context usage data from OMP runtime */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

/** Format a token count as human-readable (e.g., 50000 → "50K") */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** Build display lines for the TUI breakdown */
export function buildBreakdown(
  usage: ContextUsage | null,
  sections: PromptSection[],
  activeTools: string[],
  noSystemPrompt = false,
): string[] {
  const lines: string[] = [];

  // Header — format: "Context Breakdown (~50K / 200K tokens, 25%)"
  const headerParts: string[] = [];
  if (usage?.tokens != null && usage?.contextWindow != null) {
    headerParts.push(`~${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`);
  } else if (usage?.tokens != null) {
    headerParts.push(`~${formatTokens(usage.tokens)} tokens`);
  } else if (usage?.contextWindow != null) {
    headerParts.push(`${formatTokens(usage.contextWindow)} window`);
  }
  if (usage?.percent != null) headerParts.push(`${usage.percent}%`);
  const header = headerParts.length > 0
    ? `Context Breakdown (${headerParts.join(", ")})`
    : "Context Breakdown";
  lines.push(header);
  lines.push("─".repeat(44));

  // System prompt sections
  if (sections.length > 0) {
    const totalBytes = sections.reduce((sum, s) => sum + s.bytes, 0);
    const totalTok = estimateTokens(sections.reduce((acc, s) => acc + s.content, ""));
    lines.push(`  System Prompt${pad(`${formatSize(totalBytes)}  ~${formatTokens(totalTok)} tok`, 30)}`);

    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const isLast = i === sections.length - 1;
      const prefix = isLast ? "└" : "├";
      const tok = estimateTokens(s.content);
      lines.push(`    ${prefix} ${s.label}${pad(`${formatSize(s.bytes)}  ~${formatTokens(tok)} tok`, 28 - s.label.length)}`);
    }
  }

  // Empty prompt fallback
  if (noSystemPrompt && sections.length === 0) {
    lines.push("  No system prompt captured");
  }

  // Tools
  lines.push(`  Tools: ${activeTools.length} active`);

  // Footer
  lines.push("─".repeat(34));
  lines.push("  Close");

  return lines;
}

function pad(text: string, width: number): string {
  const padding = Math.max(1, width);
  return " ".repeat(padding) + text;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/context/analyzer.test.ts`
Expected: PASS (may need minor formatting adjustments)

- [ ] **Step 5: Commit**

```bash
git add src/context/analyzer.ts tests/context/analyzer.test.ts
git commit -m "feat(context): add buildBreakdown for TUI display formatting"
```

---

## Chunk 2: Command Handler and Bootstrap Wiring

### Task 5: `handleContext` command handler

**Files:**
- Create: `src/commands/context.ts`

- [ ] **Step 1: Write the command handler**

```typescript
// src/commands/context.ts
import type { Platform, PlatformContext } from "../platform/types.js";
import { parseSystemPrompt, buildBreakdown } from "../context/analyzer.js";
import type { ContextUsage } from "../context/analyzer.js";

export function handleContext(platform: Platform, ctx: PlatformContext): void {
  void (async () => {
    if (!ctx.hasUI) return;

    // Gather data from OMP runtime
    let usage: ContextUsage | null = null;
    try {
      const raw = (ctx as any).getContextUsage?.();
      if (raw && typeof raw === "object") {
        usage = {
          tokens: typeof raw.tokens === "number" ? raw.tokens : null,
          contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
          percent: typeof raw.percent === "number" ? raw.percent : null,
        };
      }
    } catch {
      // getContextUsage not available — continue without
    }

    let systemPrompt = "";
    try {
      systemPrompt = (ctx as any).getSystemPrompt?.() ?? "";
    } catch {
      // getSystemPrompt not available — continue without
    }

    // If we have nothing to show, notify and bail
    if (!usage && !systemPrompt) {
      ctx.ui.notify("Context data unavailable", "warning");
      return;
    }

    // Parse system prompt (may be empty)
    const sections = systemPrompt ? parseSystemPrompt(systemPrompt) : [];
    const activeTools = platform.getActiveTools();
    const lines = buildBreakdown(usage, sections, activeTools, !systemPrompt);

    await ctx.ui.select("Context Breakdown", lines, {
      helpText: "Esc to close",
    });
  })().catch((err) => {
    ctx.ui.notify(`Context error: ${(err as Error).message}`, "error");
  });
}

export function registerContextCommand(platform: Platform): void {
  platform.registerCommand("supi:context", {
    description: "Show context window breakdown — what's consuming tokens",
    async handler(_args: string | undefined, ctx: any) {
      handleContext(platform, ctx);
    },
  });
}
```

- [ ] **Step 2: Verify file compiles**

Run: `bunx tsc --noEmit src/commands/context.ts`
Expected: No errors (or only expected type issues from `any` casts)

- [ ] **Step 3: Commit**

```bash
git add src/commands/context.ts
git commit -m "feat(context): add handleContext command handler and registerContextCommand"
```

---

### Task 6: Bootstrap wiring

**Files:**
- Modify: `src/bootstrap.ts`

- [ ] **Step 1: Add import to bootstrap.ts**

Add to the imports section at the top of `src/bootstrap.ts`:

```typescript
import { registerContextCommand, handleContext } from "./commands/context.js";
```

- [ ] **Step 2: Add to TUI_COMMANDS map**

Add to the `TUI_COMMANDS` object:

```typescript
"supi:context": (platform, ctx) => handleContext(platform, ctx),
```

- [ ] **Step 3: Add registration call**

Add inside `bootstrap()` function, alongside the other `registerXCommand(platform)` calls:

```typescript
registerContextCommand(platform);
```

- [ ] **Step 4: Verify build**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.ts
git commit -m "feat(context): wire supi:context into bootstrap TUI_COMMANDS"
```

---

### Task 7: Add `/supi:context` to supi overview menu

**Files:**
- Modify: `src/commands/supi.ts`

- [ ] **Step 1: Add context command to the overview menu**

In `src/commands/supi.ts`, find the `commands` array inside `handleSupi` and add the context entry:

```typescript
"/supi:context  — Show context breakdown",
```

Add it after the existing command entries (e.g., after `/supi:release`).

- [ ] **Step 2: Verify the change**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/commands/supi.ts
git commit -m "feat(context): add supi:context to overview menu"
```

---

### Task 8: Integration smoke test and final verification

**Files:**
- Modify: `tests/integration/extension.test.ts`

- [ ] **Step 1: Add `supi:context` to the integration test**

In `tests/integration/extension.test.ts`, find the test that verifies registered commands (look for `registerCommand` assertions or a command name list). Add:

```typescript
expect(registeredCommands).toContain("supi:context");
```

Or if the test counts `registerCommand` calls, increment the expected count by 1.

- [ ] **Step 2: Run full typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/integration/extension.test.ts
git commit -m "test(context): add supi:context to integration smoke test"
```