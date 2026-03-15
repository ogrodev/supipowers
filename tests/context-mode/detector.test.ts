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
