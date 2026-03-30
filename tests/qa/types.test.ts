import { describe, test, expect } from "vitest";
import type {
  AppType,
  AppTypeInfo,
  E2eQaConfig,
  PlaywrightConfig,
  ExecutionConfig,
  E2eMatrix,
  E2eFlowRecord,
  E2ePhase,
  E2ePhaseStatus,
  E2eSessionLedger,
  E2eFlow,
  E2eTestResult,
  E2eRegression,
} from "../../src/qa/types.js";

describe("E2E QA types", () => {
  test("AppType accepts valid framework types", () => {
    const types: AppType[] = ["nextjs-app", "nextjs-pages", "react-router", "vite", "express", "generic"];
    expect(types).toHaveLength(6);
  });

  test("AppTypeInfo holds app detection result", () => {
    const info: AppTypeInfo = {
      type: "nextjs-app",
      devCommand: "npm run dev",
      port: 3000,
      baseUrl: "http://localhost:3000",
    };
    expect(info.type).toBe("nextjs-app");
    expect(info.port).toBe(3000);
  });

  test("PlaywrightConfig holds test runner preferences", () => {
    const config: PlaywrightConfig = {
      headless: true,
      timeout: 30000,
    };
    expect(config.headless).toBe(true);
    expect(config.timeout).toBe(30000);
  });

  test("E2eQaConfig composes app, playwright, and execution config", () => {
    const config: E2eQaConfig = {
      app: { type: "vite", devCommand: "npm run dev", port: 5173, baseUrl: "http://localhost:5173" },
      playwright: { headless: true, timeout: 30000 },
      execution: { maxRetries: 2, maxFlows: 20 },
    };
    expect(config.app.type).toBe("vite");
    expect(config.execution.maxRetries).toBe(2);
  });

  test("E2eFlowRecord tracks flow state across sessions", () => {
    const flow: E2eFlowRecord = {
      id: "login-flow",
      name: "User login flow",
      entryRoute: "/login",
      steps: ["Navigate to /login", "Fill email", "Fill password", "Click submit"],
      priority: "critical",
      lastStatus: "pass",
      lastTestedAt: "2026-03-12T14:00:00.000Z",
      addedAt: "2026-03-10T10:00:00.000Z",
    };
    expect(flow.lastStatus).toBe("pass");
    expect(flow.removedAt).toBeUndefined();
  });

  test("E2eFlowRecord supports soft-delete with removedAt", () => {
    const flow: E2eFlowRecord = {
      id: "old-flow",
      name: "Removed flow",
      entryRoute: "/old",
      steps: [],
      priority: "low",
      lastStatus: "untested",
      lastTestedAt: null,
      addedAt: "2026-03-01T00:00:00.000Z",
      removedAt: "2026-03-12T00:00:00.000Z",
    };
    expect(flow.removedAt).toBeDefined();
  });

  test("E2eMatrix holds persistent flow state", () => {
    const matrix: E2eMatrix = {
      version: "1.0.0",
      updatedAt: "2026-03-12T14:00:00.000Z",
      appType: "nextjs-app",
      flows: [],
    };
    expect(matrix.version).toBe("1.0.0");
    expect(matrix.flows).toEqual([]);
  });

  test("E2ePhase and E2ePhaseStatus cover all pipeline stages", () => {
    const phases: E2ePhase[] = ["flow-discovery", "test-generation", "execution", "reporting"];
    const statuses: E2ePhaseStatus[] = ["pending", "running", "completed", "failed"];
    expect(phases).toHaveLength(4);
    expect(statuses).toHaveLength(4);
  });

  test("E2eFlow represents a discovered flow for a session run", () => {
    const flow: E2eFlow = {
      id: "checkout-flow",
      name: "Checkout flow",
      entryRoute: "/checkout",
      steps: ["Add item to cart", "Go to checkout", "Enter payment", "Confirm order"],
      priority: "high",
      testFile: "tests/checkout.spec.ts",
    };
    expect(flow.testFile).toBe("tests/checkout.spec.ts");
  });

  test("E2eTestResult captures per-flow execution result", () => {
    const result: E2eTestResult = {
      flowId: "login-flow",
      testFile: "tests/login.spec.ts",
      status: "fail",
      duration: 5200,
      error: "Timeout waiting for #submit",
      screenshot: "screenshots/login-fail.png",
      retryCount: 1,
    };
    expect(result.status).toBe("fail");
    expect(result.retryCount).toBe(1);
  });

  test("E2eRegression captures a pass-to-fail transition", () => {
    const regression: E2eRegression = {
      flowId: "login-flow",
      flowName: "User login flow",
      previousStatus: "pass",
      currentStatus: "fail",
      error: "Button #submit not found",
      resolution: "bug",
    };
    expect(regression.previousStatus).toBe("pass");
    expect(regression.resolution).toBe("bug");
  });

  test("E2eSessionLedger holds full session state", () => {
    const ledger: E2eSessionLedger = {
      id: "qa-20260312-140000-abcd",
      createdAt: "2026-03-12T14:00:00.000Z",
      updatedAt: "2026-03-12T14:00:00.000Z",
      appType: "nextjs-app",
      baseUrl: "http://localhost:3000",
      phases: {
        "flow-discovery": { status: "completed", startedAt: "2026-03-12T14:00:00.000Z", completedAt: "2026-03-12T14:01:00.000Z" },
        "test-generation": { status: "running", startedAt: "2026-03-12T14:01:00.000Z" },
        "execution": { status: "pending" },
        "reporting": { status: "pending" },
      },
      flows: [],
      results: [],
      regressions: [],
      config: {
        app: { type: "nextjs-app", devCommand: "npm run dev", port: 3000, baseUrl: "http://localhost:3000" },
        playwright: { headless: true, timeout: 30000 },
        execution: { maxRetries: 2, maxFlows: 20 },
      },
    };
    expect(ledger.phases["flow-discovery"].status).toBe("completed");
    expect(ledger.phases.execution.status).toBe("pending");
    expect(ledger.regressions).toEqual([]);
  });
});
