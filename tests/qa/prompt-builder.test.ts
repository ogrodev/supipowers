import { describe, test, expect } from "vitest";
import { buildE2eOrchestratorPrompt } from "../../src/qa/prompt-builder.js";
import type { E2ePromptOptions } from "../../src/qa/prompt-builder.js";
import { DEFAULT_E2E_QA_CONFIG } from "../../src/qa/config.js";

function makeOptions(overrides: Partial<E2ePromptOptions> = {}): E2ePromptOptions {
  return {
    cwd: "/projects/my-app",
    appType: { type: "nextjs-app", devCommand: "npm run dev", port: 3000, baseUrl: "http://localhost:3000" },
    sessionDir: "/projects/my-app/.omp/supipowers/qa-sessions/qa-20260312-140000-abcd",
    scriptsDir: "/path/to/scripts",
    config: DEFAULT_E2E_QA_CONFIG,
    discoveredRoutes: '{"path": "/login", "file": "app/login/page.tsx", "type": "page", "hasForm": true}\n{"path": "/dashboard", "file": "app/dashboard/page.tsx", "type": "page", "hasForm": false}',
    previousMatrix: null,
    skillContent: "",
    ...overrides,
  };
}

describe("E2E orchestrator prompt builder", () => {
  test("includes role and app type", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("E2E QA Pipeline");
    expect(prompt).toContain("nextjs-app");
  });

  test("includes session context", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("qa-20260312-140000-abcd");
    expect(prompt).toContain("http://localhost:3000");
  });

  test("includes discovered routes", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("/login");
    expect(prompt).toContain("/dashboard");
    expect(prompt).toContain("app/login/page.tsx");
  });

  test("includes previous matrix when provided", () => {
    const matrixJson = JSON.stringify({
      version: "1.0.0",
      flows: [{ id: "login-flow", lastStatus: "pass" }],
    });
    const prompt = buildE2eOrchestratorPrompt(makeOptions({ previousMatrix: matrixJson }));
    expect(prompt).toContain("Previous Matrix");
    expect(prompt).toContain("login-flow");
  });

  test("omits previous matrix section when null", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions({ previousMatrix: null }));
    expect(prompt).not.toContain("Previous Matrix");
  });

  test("includes all four step sections", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("Flow Discovery");
    expect(prompt).toContain("Step 2");
    expect(prompt).toContain("Test Generation");
    expect(prompt).toContain("Step 3");
    expect(prompt).toContain("Execution");
    expect(prompt).toContain("Step 4");
    expect(prompt).toContain("Regression");
  });

  test("includes script paths", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("start-dev-server.sh");
    expect(prompt).toContain("run-e2e-tests.sh");
    expect(prompt).toContain("stop-dev-server.sh");
    expect(prompt).toContain("discover-routes.sh");
  });

  test("includes token guidance", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("run-e2e-tests.sh");
    expect(prompt).toContain("never run playwright directly");
  });

  test("includes skill content when provided", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions({
      skillContent: "## E2E Testing Best Practices\nAlways use data-testid attributes.",
    }));
    expect(prompt).toContain("E2E Testing Best Practices");
    expect(prompt).toContain("data-testid");
  });

  test("includes config values in context", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("chromium");
    expect(prompt).toContain("maxRetries");
  });

  test("includes regression detection instructions", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("regression");
    expect(prompt).toContain("e2e-matrix.json");
  });

  test("includes dev server management instructions", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("npm run dev");
    expect(prompt).toContain("start-dev-server.sh");
    expect(prompt).toContain("stop-dev-server.sh");
  });

  test("includes playwright test writing instructions", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright");
    expect(prompt).toContain(".spec.ts");
  });
});
