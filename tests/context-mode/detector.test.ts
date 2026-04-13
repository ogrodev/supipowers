// tests/context-mode/detector.test.ts
import { detectContextMode } from "../../src/context-mode/detector.js";

describe("detectContextMode", () => {
  test("returns available: true unconditionally", () => {
    const status = detectContextMode([]);
    expect(status.available).toBe(true);
  });

  test("all tool booleans are true regardless of active tools list", () => {
    const status = detectContextMode(["bash", "read"]);
    expect(status.tools.ctxExecute).toBe(true);
    expect(status.tools.ctxBatchExecute).toBe(true);
    expect(status.tools.ctxExecuteFile).toBe(true);
    expect(status.tools.ctxIndex).toBe(true);
    expect(status.tools.ctxSearch).toBe(true);
    expect(status.tools.ctxFetchAndIndex).toBe(true);
  });

  test("available with no arguments", () => {
    const status = detectContextMode();
    expect(status.available).toBe(true);
    expect(status.tools.ctxExecute).toBe(true);
  });

  test("available with empty tools list", () => {
    const status = detectContextMode([]);
    expect(status.available).toBe(true);
  });

  test("ContextModeStatus interface shape is preserved", () => {
    const status = detectContextMode(["anything"]);
    expect(status).toHaveProperty("available");
    expect(status).toHaveProperty("tools");
    expect(status.tools).toHaveProperty("ctxExecute");
    expect(status.tools).toHaveProperty("ctxBatchExecute");
    expect(status.tools).toHaveProperty("ctxExecuteFile");
    expect(status.tools).toHaveProperty("ctxIndex");
    expect(status.tools).toHaveProperty("ctxSearch");
    expect(status.tools).toHaveProperty("ctxFetchAndIndex");
  });
});
