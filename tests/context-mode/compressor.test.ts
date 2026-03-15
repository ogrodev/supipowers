// tests/context-mode/compressor.test.ts
import { compressToolResult } from "../../src/context-mode/compressor.js";

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
  input?: { offset?: number; limit?: number },
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
