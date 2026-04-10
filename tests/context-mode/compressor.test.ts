// tests/context-mode/compressor.test.ts
import { compressToolResult, compressToolResultWithLLM } from "../../src/context-mode/compressor.js";

// Helper to create a text-only tool result event
function bashResult(
  text: string,
  details?: { exitCode?: number },
  isError = false,
) {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "test-id",
    input: { command: "test" },
    content: [{ type: "text", text }],
    isError,
    details: details ? { exitCode: details.exitCode ?? 0 } : undefined,
  } as any;
}

function readResult(
  text: string,
  input?: { offset?: number; limit?: number; sel?: string },
  isError = false,
) {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: "test-id",
    input: { path: "/test/file.ts", ...input },
    content: [{ type: "text", text }],
    isError,
    details: undefined,
  } as any;
}

function grepResult(text: string, isError = false) {
  return {
    type: "tool_result",
    toolName: "grep",
    toolCallId: "test-id",
    input: { pattern: "test", path: "src/" },
    content: [{ type: "text", text }],
    isError,
    details: undefined,
  } as any;
}

function findResult(text: string, isError = false) {
  return {
    type: "tool_result",
    toolName: "find",
    toolCallId: "test-id",
    input: { pattern: "*.ts" },
    content: [{ type: "text", text }],
    isError,
    details: undefined,
  } as any;
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
      } as any;
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
      } as any;
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
      expect(text.text).toContain("lines omitted (");
    });
  });

  describe("read compression", () => {
    test("passes through scoped reads (with offset/limit)", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `${i+1}#XX:line ${i}`).join("\n");
      const result = compressToolResult(
        readResult(lines, { offset: 10, limit: 20 }),
        THRESHOLD,
      );
      expect(result).toBeUndefined();
    });

    test("passes through scoped reads with sel", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `${i+1}#XX:line ${i}`).join("\n");
      const result = compressToolResult(readResult(lines, { sel: "L50-L120" }), THRESHOLD);
      expect(result).toBeUndefined();
    });

    test("passes through files at boundary (110 lines)", () => {
      const lines = Array.from({ length: 110 }, (_, i) => `${i+1}#XX:line ${i}`).join("\n");
      const result = compressToolResult(readResult(lines), THRESHOLD);
      expect(result).toBeUndefined();
    });

    test("compresses files above boundary (111 lines) with head+tail", () => {
      const lines = Array.from({ length: 111 }, (_, i) => `${i+1}#XX:line ${i}`).join("\n");
      const result = compressToolResult(readResult(lines), THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      // Head preserved
      expect(text.text).toContain("1#XX:line 0");
      expect(text.text).toContain("80#XX:line 79");
      // Tail preserved
      expect(text.text).toContain("111#XX:line 110");
      expect(text.text).toContain("82#XX:line 81");
      // Compression marker with sel hint
      expect(text.text).toContain('sel="L81-L81"');
    });

    test("preserves hashline prefixes on all surviving lines", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `${i+1}#AB:content line ${i}`).join("\n");
      const result = compressToolResult(readResult(lines), THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      const outputLines = text.text.split("\n");
      // Every non-marker line should have hashline prefix
      const contentLines = outputLines.filter(l => !l.startsWith("["));
      for (const line of contentLines) {
        expect(line).toMatch(/^\d+#[A-Z]{2}:/);
      }
    });

    test("compression marker includes correct sel range", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `${i+1}#ZZ:line ${i}`).join("\n");
      const result = compressToolResult(readResult(lines), THRESHOLD);
      expect(result).toBeDefined();
      const text = result!.content![0] as { type: string; text: string };
      // 200 lines: head=80, tail=30, omitted=81..170 (90 lines)
      expect(text.text).toContain('90 lines omitted');
      expect(text.text).toContain('sel="L81-L170"');
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


describe("compressToolResultWithLLM", () => {
  const LLM_THRESHOLD = 500;

  function makeSummarize(behavior: { returns?: string; throws?: boolean } = {}) {
    const calls: Array<{ prompt: string; toolName: string }> = [];
    const fn = async (prompt: string, toolName: string): Promise<string> => {
      calls.push({ prompt, toolName });
      if (behavior.throws) throw new Error("llm failure");
      return (
        behavior.returns ??
        "Default summary long enough to pass the 50-char validation check."
      );
    };
    return { fn, calls };
  }

  test("isError=true short-circuits without calling summarize", async () => {
    const { fn, calls } = makeSummarize();
    const bigError = "x".repeat(LLM_THRESHOLD + 100);
    const result = await compressToolResultWithLLM(
      bashResult(bigError, undefined, true),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("non-text content short-circuits without calling summarize", async () => {
    const { fn, calls } = makeSummarize();
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "test" },
      content: [
        { type: "text", text: "x".repeat(LLM_THRESHOLD + 100) },
        {
          type: "image",
          source: { type: "base64", data: "...", media_type: "image/png" },
        },
      ],
      isError: false,
      details: undefined,
    } as any;
    const result = await compressToolResultWithLLM(
      event,
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("below threshold short-circuits without calling summarize", async () => {
    const { fn, calls } = makeSummarize();
    const result = await compressToolResultWithLLM(
      bashResult("small"),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  test("between threshold and llmThreshold uses structural compression", async () => {
    const { fn, calls } = makeSummarize();
    // 50 bash lines ~= 389 bytes: above THRESHOLD (100), below LLM_THRESHOLD (500)
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = await compressToolResultWithLLM(
      bashResult(lines, { exitCode: 0 }),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("[...compressed:");
    expect(text.text).toContain("line 0");
    expect(text.text).toContain("line 49");
    expect(calls.length).toBe(0);
  });

  test("above llmThreshold: valid LLM summary is returned verbatim", async () => {
    const summary =
      "This is a long summary that definitely exceeds fifty characters in total length.";
    const { fn, calls } = makeSummarize({ returns: summary });
    const bigText = "x".repeat(LLM_THRESHOLD + 200);
    const result = await compressToolResultWithLLM(
      bashResult(bigText, { exitCode: 0 }),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toBe(summary);
    expect(calls.length).toBe(1);
    expect(calls[0]!.toolName).toBe("bash");
  });

  test("bash tool uses bash-specific prompt template", async () => {
    const { fn, calls } = makeSummarize();
    const bigText = "x".repeat(LLM_THRESHOLD + 200);
    await compressToolResultWithLLM(
      bashResult(bigText, { exitCode: 0 }),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt.startsWith("Summarize this command output")).toBe(
      true,
    );
  });

  test("read tool uses read-specific prompt template", async () => {
    const { fn, calls } = makeSummarize();
    const bigText = "x".repeat(LLM_THRESHOLD + 200);
    await compressToolResultWithLLM(
      readResult(bigText),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt.startsWith("Summarize this file content")).toBe(true);
  });

  test("grep tool uses grep-specific prompt template", async () => {
    const { fn, calls } = makeSummarize();
    const bigText = "x".repeat(LLM_THRESHOLD + 200);
    await compressToolResultWithLLM(
      grepResult(bigText),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt.startsWith("Summarize these search results")).toBe(
      true,
    );
  });

  test("find tool uses find-specific prompt template", async () => {
    const { fn, calls } = makeSummarize();
    const bigText = "x".repeat(LLM_THRESHOLD + 200);
    await compressToolResultWithLLM(
      findResult(bigText),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt.startsWith("Summarize these file paths")).toBe(true);
  });

  test("unknown tool uses default prompt and returns summary on success", async () => {
    const { fn, calls } = makeSummarize();
    const event = {
      type: "tool_result",
      toolName: "unknown_tool",
      toolCallId: "test-id",
      input: {},
      content: [{ type: "text", text: "x".repeat(LLM_THRESHOLD + 200) }],
      isError: false,
      details: undefined,
    } as any;
    const result = await compressToolResultWithLLM(
      event,
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt.startsWith("Summarize this output concisely")).toBe(
      true,
    );
  });

  test("unknown tool with LLM failure falls back to undefined", async () => {
    const { fn } = makeSummarize({ throws: true });
    const event = {
      type: "tool_result",
      toolName: "unknown_tool",
      toolCallId: "test-id",
      input: {},
      content: [{ type: "text", text: "x".repeat(LLM_THRESHOLD + 200) }],
      isError: false,
      details: undefined,
    } as any;
    const result = await compressToolResultWithLLM(
      event,
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeUndefined();
  });

  test("LLM throws: falls back to structural compression for bash", async () => {
    const { fn } = makeSummarize({ throws: true });
    // 50 lines of content + pad to exceed llmThreshold
    const padded = Array.from(
      { length: 50 },
      (_, i) => `line ${i} ${"x".repeat(20)}`,
    ).join("\n");
    const event = bashResult(padded, { exitCode: 0 });
    const result = await compressToolResultWithLLM(
      event,
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("[...compressed:");
  });

  test("LLM returns empty string: falls back to structural compression", async () => {
    const { fn } = makeSummarize({ returns: "" });
    const padded = Array.from(
      { length: 50 },
      (_, i) => `line ${i} ${"x".repeat(20)}`,
    ).join("\n");
    const event = bashResult(padded, { exitCode: 0 });
    const result = await compressToolResultWithLLM(
      event,
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("[...compressed:");
  });

  test("LLM returns summary shorter than 50 chars: falls back to structural", async () => {
    const short = "too short";
    expect(short.length).toBeLessThan(50);
    const { fn } = makeSummarize({ returns: short });
    const padded = Array.from(
      { length: 50 },
      (_, i) => `line ${i} ${"x".repeat(20)}`,
    ).join("\n");
    const event = bashResult(padded, { exitCode: 0 });
    const result = await compressToolResultWithLLM(
      event,
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).not.toBe(short);
    expect(text.text).toContain("[...compressed:");
  });

  test("LLM returns exactly 50-char summary: accepted (boundary)", async () => {
    const exactly50 = "a".repeat(50);
    expect(exactly50.length).toBe(50);
    const { fn } = makeSummarize({ returns: exactly50 });
    const bigText = "x".repeat(LLM_THRESHOLD + 200);
    const result = await compressToolResultWithLLM(
      bashResult(bigText, { exitCode: 0 }),
      THRESHOLD,
      LLM_THRESHOLD,
      fn,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toBe(exactly50);
  });
});

describe("compressToolResult boundary edges", () => {
  test("bash: exactly 15 lines (head+tail boundary) returns undefined", () => {
    // 109 bytes (> THRESHOLD), 15 lines (== BASH_HEAD+BASH_TAIL)
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
    const result = compressToolResult(
      bashResult(lines, { exitCode: 0 }),
      THRESHOLD,
    );
    expect(result).toBeUndefined();
  });

  test("bash: 16 lines (boundary + 1) triggers compression", () => {
    const lines = Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n");
    const result = compressToolResult(
      bashResult(lines, { exitCode: 0 }),
      THRESHOLD,
    );
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("[...compressed:");
    expect(text.text).toContain("16 lines total");
  });

  test("bash: details=undefined defaults exit code to 0 and compresses", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    // bashResult called with no details → details: undefined on the event
    const event = bashResult(lines);
    expect(event.details).toBeUndefined();
    const result = compressToolResult(event, THRESHOLD);
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("[...compressed:");
  });

  test("read: only limit set (no offset) passes through", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = compressToolResult(
      readResult(lines, { limit: 20 }),
      THRESHOLD,
    );
    expect(result).toBeUndefined();
  });

  test("read: only offset set (no limit) passes through", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = compressToolResult(
      readResult(lines, { offset: 10 }),
      THRESHOLD,
    );
    expect(result).toBeUndefined();
  });

  test("read: exactly 110 lines (head+tail boundary) returns undefined", () => {
    const lines = Array.from({ length: 110 }, (_, i) => `${i+1}#XX:line ${i}`).join(
      "\n",
    );
    const result = compressToolResult(readResult(lines), THRESHOLD);
    expect(result).toBeUndefined();
  });

  test("read: 111 lines (boundary + 1) triggers compression", () => {
    const lines = Array.from({ length: 111 }, (_, i) => `${i+1}#XX:line ${i}`).join(
      "\n",
    );
    const result = compressToolResult(readResult(lines), THRESHOLD);
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("1#XX:line 0");
    expect(text.text).toContain('sel="L81-L81"');
  });

  test("grep: exactly 10 matches (GREP_MAX_MATCHES boundary) returns undefined", () => {
    const lines = Array.from(
      { length: 10 },
      (_, i) => `file${i}.ts:${i}: match`,
    ).join("\n");
    const result = compressToolResult(grepResult(lines), THRESHOLD);
    expect(result).toBeUndefined();
  });

  test("grep: 11 matches (boundary + 1) triggers compression", () => {
    const lines = Array.from(
      { length: 11 },
      (_, i) => `file${i}.ts:${i}: match`,
    ).join("\n");
    const result = compressToolResult(grepResult(lines), THRESHOLD);
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("11 matches total");
  });

  test("find: exactly 20 paths (FIND_MAX_PATHS boundary) returns undefined", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `src/file${i}.ts`,
    ).join("\n");
    const result = compressToolResult(findResult(lines), THRESHOLD);
    expect(result).toBeUndefined();
  });

  test("find: 21 paths (boundary + 1) triggers compression", () => {
    const lines = Array.from(
      { length: 21 },
      (_, i) => `src/file${i}.ts`,
    ).join("\n");
    const result = compressToolResult(findResult(lines), THRESHOLD);
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("21 files found");
  });

  test("measures multi-byte UTF-8 by byte length, not character count", () => {
    // 20 lines of '你好': 139 bytes but only 59 chars total
    // THRESHOLD=100 would be below on chars (59) but above on bytes (139)
    const text = Array.from({ length: 20 }, () => "你好").join("\n");
    expect(text.length).toBeLessThan(THRESHOLD);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(THRESHOLD);
    const event = bashResult(text, { exitCode: 0 });
    const result = compressToolResult(event, THRESHOLD);
    expect(result).toBeDefined();
    const out = result!.content![0] as { type: string; text: string };
    expect(out.text).toContain("[...compressed:");
  });

  test("combines multiple text entries when measuring and compressing", () => {
    // Two entries whose combined joined text exceeds BASH_HEAD+BASH_TAIL lines
    const e1 = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const e2 = Array.from({ length: 10 }, (_, i) => `other ${i}`).join("\n");
    const event = {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "test-id",
      input: { command: "test" },
      content: [
        { type: "text", text: e1 },
        { type: "text", text: e2 },
      ],
      isError: false,
      details: { exitCode: 0 },
    } as any;
    const result = compressToolResult(event, THRESHOLD);
    expect(result).toBeDefined();
    const text = result!.content![0] as { type: string; text: string };
    expect(text.text).toContain("[...compressed:");
    // Head should contain e1 lines; tail should contain e2 lines
    expect(text.text).toContain("line 0");
    expect(text.text).toContain("other 9");
  });

  test("isError=true preempts compression for non-bash tools (grep)", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `file${i}.ts:${i}: match`,
    ).join("\n");
    const result = compressToolResult(grepResult(lines, true), THRESHOLD);
    expect(result).toBeUndefined();
  });
});
