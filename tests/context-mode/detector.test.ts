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

  test("returns available: true with new OMP-style MCP names (supi_context_mode)", () => {
    const tools = [
      "bash", "read", "edit",
      "mcp_supi_context_mode_ctx_execute",
      "mcp_supi_context_mode_ctx_batch_execute",
      "mcp_supi_context_mode_ctx_execute_file",
      "mcp_supi_context_mode_ctx_index",
      "mcp_supi_context_mode_ctx_search",
      "mcp_supi_context_mode_ctx_fetch_and_index",
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

  test("detects partial availability (new OMP-style supi_context_mode names)", () => {
    const status = detectContextMode([
      "bash",
      "mcp_supi_context_mode_ctx_execute",
      "mcp_supi_context_mode_ctx_search",
    ]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(false);
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


describe("detectContextMode edge cases", () => {
  test("mixed naming conventions in same list", () => {
    const status = detectContextMode([
      "ctx_execute",
      "mcp__plugin_context-mode_context-mode__ctx_search",
      "mcp_context_mode_ctx_execute_file",
    ]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxExecuteFile).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(false);
    expect(status.tools.ctxIndex).toBe(false);
    expect(status.tools.ctxFetchAndIndex).toBe(false);
  });

  test("same tool appearing under multiple prefixes is idempotent", () => {
    const status = detectContextMode([
      "ctx_execute",
      "mcp_context_mode_ctx_execute",
    ]);
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxExecuteFile).toBe(false);
    expect(status.tools.ctxBatchExecute).toBe(false);
  });

  test("tool containing suffix but without known prefix is rejected", () => {
    const status = detectContextMode(["my_ctx_execute_tool"]);
    expect(status.available).toBe(false);
    expect(status.tools.ctxExecute).toBe(false);
  });

  test("known prefix+suffix with extra trailing text is rejected", () => {
    // matchesSuffix uses full equality, so trailing `_extra` must not match
    const status = detectContextMode(["mcp_context_mode_ctx_execute_file_extra"]);
    expect(status.available).toBe(false);
    expect(status.tools.ctxExecuteFile).toBe(false);
    expect(status.tools.ctxExecute).toBe(false);
  });

  test("empty string in tools list detects nothing", () => {
    const status = detectContextMode([""]);
    expect(status.available).toBe(false);
    expect(status.tools.ctxExecute).toBe(false);
    expect(status.tools.ctxBatchExecute).toBe(false);
    expect(status.tools.ctxExecuteFile).toBe(false);
    expect(status.tools.ctxIndex).toBe(false);
    expect(status.tools.ctxSearch).toBe(false);
    expect(status.tools.ctxFetchAndIndex).toBe(false);
  });

  test("very long tool list still detects a single valid ctx_search", () => {
    const noise: string[] = [];
    for (let i = 0; i < 1000; i++) {
      noise.push(`unrelated_tool_${i}`);
    }
    noise.push("ctx_search");
    const status = detectContextMode(noise);
    expect(status.available).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxExecute).toBe(false);
    expect(status.tools.ctxBatchExecute).toBe(false);
    expect(status.tools.ctxExecuteFile).toBe(false);
    expect(status.tools.ctxIndex).toBe(false);
    expect(status.tools.ctxFetchAndIndex).toBe(false);
  });

  test("detects ctx_execute individually", () => {
    const s = detectContextMode(["ctx_execute"]);
    expect(s.available).toBe(true);
    expect(s.tools.ctxExecute).toBe(true);
    expect(s.tools.ctxBatchExecute).toBe(false);
    expect(s.tools.ctxExecuteFile).toBe(false);
    expect(s.tools.ctxIndex).toBe(false);
    expect(s.tools.ctxSearch).toBe(false);
    expect(s.tools.ctxFetchAndIndex).toBe(false);
  });

  test("detects ctx_batch_execute individually", () => {
    const s = detectContextMode(["ctx_batch_execute"]);
    expect(s.available).toBe(true);
    expect(s.tools.ctxBatchExecute).toBe(true);
    expect(s.tools.ctxExecute).toBe(false);
    expect(s.tools.ctxExecuteFile).toBe(false);
    expect(s.tools.ctxIndex).toBe(false);
    expect(s.tools.ctxSearch).toBe(false);
    expect(s.tools.ctxFetchAndIndex).toBe(false);
  });

  test("detects ctx_execute_file individually", () => {
    const s = detectContextMode(["ctx_execute_file"]);
    expect(s.available).toBe(true);
    expect(s.tools.ctxExecuteFile).toBe(true);
    expect(s.tools.ctxExecute).toBe(false);
    expect(s.tools.ctxBatchExecute).toBe(false);
    expect(s.tools.ctxIndex).toBe(false);
    expect(s.tools.ctxSearch).toBe(false);
    expect(s.tools.ctxFetchAndIndex).toBe(false);
  });

  test("detects ctx_index individually", () => {
    const s = detectContextMode(["ctx_index"]);
    expect(s.available).toBe(true);
    expect(s.tools.ctxIndex).toBe(true);
    expect(s.tools.ctxExecute).toBe(false);
    expect(s.tools.ctxBatchExecute).toBe(false);
    expect(s.tools.ctxExecuteFile).toBe(false);
    expect(s.tools.ctxSearch).toBe(false);
    expect(s.tools.ctxFetchAndIndex).toBe(false);
  });

  test("detects ctx_search individually", () => {
    const s = detectContextMode(["ctx_search"]);
    expect(s.available).toBe(true);
    expect(s.tools.ctxSearch).toBe(true);
    expect(s.tools.ctxExecute).toBe(false);
    expect(s.tools.ctxBatchExecute).toBe(false);
    expect(s.tools.ctxExecuteFile).toBe(false);
    expect(s.tools.ctxIndex).toBe(false);
    expect(s.tools.ctxFetchAndIndex).toBe(false);
  });

  test("detects ctx_fetch_and_index individually", () => {
    const s = detectContextMode(["ctx_fetch_and_index"]);
    expect(s.available).toBe(true);
    expect(s.tools.ctxFetchAndIndex).toBe(true);
    expect(s.tools.ctxExecute).toBe(false);
    expect(s.tools.ctxBatchExecute).toBe(false);
    expect(s.tools.ctxExecuteFile).toBe(false);
    expect(s.tools.ctxIndex).toBe(false);
    expect(s.tools.ctxSearch).toBe(false);
  });

  test("duplicate suffix with unknown prefix is rejected", () => {
    const status = detectContextMode(["random_prefix_ctx_execute"]);
    expect(status.available).toBe(false);
    expect(status.tools.ctxExecute).toBe(false);
  });

  test("ctx_execute alone does not imply ctx_execute_file", () => {
    const status = detectContextMode(["ctx_execute"]);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxExecuteFile).toBe(false);
  });

  test("ctx_execute_file alone does not imply ctx_execute", () => {
    const status = detectContextMode(["ctx_execute_file"]);
    expect(status.tools.ctxExecuteFile).toBe(true);
    expect(status.tools.ctxExecute).toBe(false);
  });
});
