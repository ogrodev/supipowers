// tests/context-mode/detector.test.ts
import { detectContextMode } from "../../src/context-mode/detector.js";

describe("detectContextMode", () => {
  test("no-argument call returns the legacy all-true fallback", () => {
    // The no-argument shape is preserved for callers (e.g. older entry points)
    // that don't have access to the runtime's active-tool list. They get the
    // optimistic "all ctx_* tools registered" view that pre-cd95f31 callers expect.
    const status = detectContextMode();
    expect(status.available).toBe(true);
    expect(Object.values(status.tools).every(Boolean)).toBe(true);
  });

  test("empty active-tools list reports no ctx_* tools available", () => {
    // With no tools active, nothing in the tool catalog can rescue large output.
    // Routing/prompt code uses `available === false` to skip injecting rescue
    // text and to stop blocking native tools that have no replacement.
    const status = detectContextMode([]);
    expect(status.available).toBe(false);
    expect(Object.values(status.tools).every((value) => value === false)).toBe(true);
  });

  test("active list with no ctx_* names ignores non-ctx tools", () => {
    const status = detectContextMode(["bash", "read", "grep"]);
    expect(status.available).toBe(false);
    expect(status.tools.ctxExecute).toBe(false);
    expect(status.tools.ctxSearch).toBe(false);
  });

  test("flags individual ctx tools based on the active set", () => {
    const status = detectContextMode(["ctx_execute", "ctx_search"]);
    expect(status.available).toBe(true);
    expect(status.tools).toMatchObject({
      ctxExecute: true,
      ctxSearch: true,
      ctxBatchExecute: false,
      ctxExecuteFile: false,
      ctxIndex: false,
      ctxFetchAndIndex: false,
      ctxStats: false,
      ctxPurge: false,
    });
  });

  test("ContextModeStatus interface shape is preserved", () => {
    const status = detectContextMode(["ctx_execute"]);
    expect(status).toHaveProperty("available");
    expect(status).toHaveProperty("tools");
    for (const key of [
      "ctxExecute",
      "ctxBatchExecute",
      "ctxExecuteFile",
      "ctxIndex",
      "ctxSearch",
      "ctxFetchAndIndex",
      "ctxStats",
      "ctxPurge",
    ] as const) {
      expect(status.tools).toHaveProperty(key);
    }
  });
});
