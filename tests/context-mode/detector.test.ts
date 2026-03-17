// tests/context-mode/detector.test.ts
import { detectContextMode } from "../../src/context-mode/detector.js";

describe("detectContextMode", () => {
  test("returns available: true when all ctx_* tools present (bare names)", () => {
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

  test("returns available: true with MCP-namespaced tool names", () => {
    const tools = [
      "bash", "read", "edit",
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
      "mcp__plugin_context-mode_context-mode__ctx_execute_file",
      "mcp__plugin_context-mode_context-mode__ctx_index",
      "mcp__plugin_context-mode_context-mode__ctx_search",
      "mcp__plugin_context-mode_context-mode__ctx_fetch_and_index",
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

  test("detects partial availability (bare names)", () => {
    const status = detectContextMode(["bash", "ctx_execute", "ctx_search"]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(false);
    expect(status.tools.ctxIndex).toBe(false);
  });

  test("detects partial availability (MCP-namespaced names)", () => {
    const status = detectContextMode([
      "bash",
      "mcp__plugin_context-mode_context-mode__ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_search",
    ]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(false);
    expect(status.tools.ctxIndex).toBe(false);
  });

  test("returns available: true with OMP-style MCP names (single underscore)", () => {
    const tools = [
      "bash", "read", "edit",
      "mcp_context_mode_ctx_execute",
      "mcp_context_mode_ctx_batch_execute",
      "mcp_context_mode_ctx_execute_file",
      "mcp_context_mode_ctx_index",
      "mcp_context_mode_ctx_search",
      "mcp_context_mode_ctx_fetch_and_index",
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

  test("detects partial availability (OMP-style names)", () => {
    const status = detectContextMode([
      "bash",
      "mcp_context_mode_ctx_execute",
      "mcp_context_mode_ctx_search",
    ]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(false);
  });

  test("returns available: false for empty tools list", () => {
    const status = detectContextMode([]);
    expect(status.available).toBe(false);
  });

  test("ignores unrelated MCP tools with similar suffixes", () => {
    const status = detectContextMode([
      "mcp__other_server__ctx_execute_something_else",
      "mcp__foo__not_ctx_execute",
    ]);
    expect(status.available).toBe(false);
  });
});
