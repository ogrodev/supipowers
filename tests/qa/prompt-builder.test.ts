
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
    dotDirDisplay: ".omp",
    ...overrides,
  };
}

describe("E2E orchestrator prompt builder", () => {
  test("includes role and app type", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("E2E QA Pipeline");
    expect(prompt).toContain("nextjs-app");
  });

  test("includes session context with config values", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("qa-20260312-140000-abcd");
    expect(prompt).toContain("http://localhost:3000");
    expect(prompt).toContain("30000"); // timeout
    expect(prompt).toContain("maxRetries");
  });

  test("does not reference browser field in session context", () => {
    // browser field was removed from PlaywrightConfig; prompt must not mention it
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).not.toMatch(/Browser:\s/);
  });

  // ── Discovery phase: playwright-cli interactive exploration ──────

  test("discovery phase instructs agent to use playwright-cli open", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli open");
  });

  test("discovery phase instructs agent to use playwright-cli snapshot", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli snapshot");
  });

  test("discovery phase instructs agent to use playwright-cli click and goto", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli click");
    expect(prompt).toContain("playwright-cli goto");
  });

  test("discovery phase instructs agent to use playwright-cli fill", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli fill");
  });

  test("discovery phase instructs agent to use playwright-cli screenshot", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli screenshot");
  });

  test("discovery phase includes base URL in playwright-cli open command", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli open");
    expect(prompt).toContain("http://localhost:3000");
  });

  // ── Route hints (not authoritative source anymore) ──────────────

  test("includes discovered routes as starting hints", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("/login");
    expect(prompt).toContain("/dashboard");
    expect(prompt).toContain("app/login/page.tsx");
    // Routes are starting hints, not authoritative
    expect(prompt).toMatch(/hint/i);
  });

  // ── Previous matrix ─────────────────────────────────────────────

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

  // ── Four-step pipeline structure ────────────────────────────────

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

  // ── Skill content ───────────────────────────────────────────────

  test("includes skill content when provided", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions({
      skillContent: "## E2E Testing Best Practices\nAlways use data-testid attributes.",
    }));
    expect(prompt).toContain("E2E Testing Best Practices");
    expect(prompt).toContain("data-testid");
  });

  // ── Test generation ─────────────────────────────────────────────

  test("includes playwright test writing instructions with .spec.ts files", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain(".spec.ts");
    expect(prompt).toContain("playwright/test");
    expect(prompt).not.toContain("@playwright/test");
  });

  // ── Execution phase ─────────────────────────────────────────────

  test("execution references run-e2e-tests.sh", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("run-e2e-tests.sh");
  });

  test("execution does not reference npx playwright", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).not.toContain("npx playwright");
  });

  test("includes dev server management instructions", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("npm run dev");
    expect(prompt).toContain("start-dev-server.sh");
    expect(prompt).toContain("stop-dev-server.sh");
  });

  // ── Script paths ────────────────────────────────────────────────

  test("script paths section does not include ensure-playwright.sh", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).not.toContain("ensure-playwright.sh");
  });

  test("script paths include run-e2e-tests.sh and dev server scripts", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("start-dev-server.sh");
    expect(prompt).toContain("run-e2e-tests.sh");
    expect(prompt).toContain("stop-dev-server.sh");
    expect(prompt).toContain("discover-routes.sh");
  });

  // ── Token guidance ──────────────────────────────────────────────

  test("includes token guidance referencing run-e2e-tests.sh", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("run-e2e-tests.sh");
    expect(prompt).toContain("never run playwright directly");
  });

  test("token guidance recommends snapshot over screenshot for structure", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli snapshot");
    expect(prompt).toContain("instead of");
    expect(prompt).toContain("playwright-cli screenshot");
  });

  // ── Regression analysis ─────────────────────────────────────────

  test("includes regression detection instructions", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("regression");
    expect(prompt).toContain("e2e-matrix.json");
  });

  // ── Diagnostic note ─────────────────────────────────────────────

  test("includes playwright-cli diagnostic note for troubleshooting", () => {
    // Per spec: "telling the agent to check playwright-cli --version if open fails"
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli --version");
  });

  // ── Headless flag mapping ───────────────────────────────────────

  test("includes headless config in session context", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("Headless");
  });

  test("playwright-cli open includes --headed when headless is false", () => {
    const config = {
      ...DEFAULT_E2E_QA_CONFIG,
      playwright: { ...DEFAULT_E2E_QA_CONFIG.playwright, headless: false },
    };
    const prompt = buildE2eOrchestratorPrompt(makeOptions({ config }));
    expect(prompt).toContain("playwright-cli open --headed http://localhost:3000");
  });

  test("playwright-cli open omits --headed when headless is true", () => {
    const prompt = buildE2eOrchestratorPrompt(makeOptions());
    expect(prompt).toContain("playwright-cli open http://localhost:3000");
    expect(prompt).not.toContain("--headed");
  });
});
