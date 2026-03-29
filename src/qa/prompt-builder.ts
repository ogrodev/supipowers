import type { AppTypeInfo, E2eQaConfig } from "./types.js";

export interface E2ePromptOptions {
  cwd: string;
  appType: AppTypeInfo;
  sessionDir: string;
  scriptsDir: string;
  config: E2eQaConfig;
  discoveredRoutes: string;
  previousMatrix: string | null;
  skillContent: string;
  dotDirDisplay: string;
}

export function buildE2eOrchestratorPrompt(options: E2ePromptOptions): string {
  const { appType, sessionDir, scriptsDir, config, discoveredRoutes, previousMatrix, skillContent, dotDirDisplay } = options;
  const { playwright, execution } = config;

  const sections: string[] = [
    "# E2E QA Pipeline — Autonomous Execution",
    "",
    `You are an autonomous E2E QA pipeline for a **${appType.type}** application.`,
    "Run all phases sequentially without stopping. Use the provided scripts for heavy operations.",
    "",
    "## Session Context",
    "",
    `- Session dir: \`${sessionDir}\``,
    `- Base URL: \`${appType.baseUrl}\``,
    `- Dev command: \`${appType.devCommand}\``,
    `- Port: ${appType.port}`,
    `- Browser: ${playwright.browser}`,
    `- Headless: ${playwright.headless}`,
    `- Test timeout: ${playwright.timeout}ms`,
    `- maxRetries: ${execution.maxRetries}`,
    `- maxFlows: ${execution.maxFlows}`,
    "",
  ];

  // Previous matrix
  if (previousMatrix) {
    sections.push(
      "## Previous Matrix",
      "",
      `Last-known flow states from \`${dotDirDisplay}/supipowers/e2e-matrix.json\`:`,
      "",
      "```json",
      previousMatrix,
      "```",
      "",
      "Compare your findings against this matrix to detect regressions, new flows, and removed flows.",
      "",
    );
  }

  // Discovered routes
  sections.push(
    "## Discovered Routes",
    "",
    "Pre-scanned routes/pages/forms from the codebase (JSONL):",
    "",
    "```jsonl",
    discoveredRoutes,
    "```",
    "",
    "Use these as a starting point. You may discover additional flows by reading the codebase.",
    "",
  );

  // Skill content
  if (skillContent) {
    sections.push(
      "## E2E Testing Methodology",
      "",
      skillContent,
      "",
    );
  }

  // Step 1: Flow Discovery
  sections.push(
    "## Step 1: Flow Discovery",
    "",
    "Analyze the discovered routes and the codebase to identify user flows:",
    "",
    "1. Read the route scan output above",
    "2. Explore the codebase for additional flows not captured by the scan (modals, multi-step wizards, etc.)",
    "3. Identify forms, auth flows, CRUD operations, navigation patterns",
    "4. Compare against the previous matrix (if any) to detect:",
    "   - **New flows**: routes that weren't in the matrix before",
    "   - **Removed flows**: routes in the matrix that no longer exist",
    "   - **Changed flows**: routes whose structure or behavior changed",
    "5. Assign priority: critical (auth, payment), high (core CRUD), medium (secondary features), low (nice-to-have)",
    `6. Write the flow manifest to \`${sessionDir}/flows.json\``,
    "",
  );

  // Step 2: Test Generation
  sections.push(
    "## Step 2: Test Generation",
    "",
    "Write playwright test specs for each discovered flow:",
    "",
    `1. Create \`.spec.ts\` files in \`${sessionDir}/tests/\``,
    "2. Each flow gets its own test file",
    "3. Use playwright best practices:",
    "   - Use `page.getByRole()`, `page.getByText()`, `page.getByTestId()` for locators",
    "   - Use `expect(page).toHaveURL()`, `expect(locator).toBeVisible()` for assertions",
    "   - Use `page.waitForLoadState('networkidle')` or `page.waitForSelector()` before assertions",
    "   - Set meaningful test descriptions that describe the user journey",
    `4. Import from \`@playwright/test\``,
    `5. Each test should start with \`await page.goto('${appType.baseUrl}/...')\``,
    "",
    "Example test structure:",
    "```typescript",
    "import { test, expect } from '@playwright/test';",
    "",
    "test.describe('Login flow', () => {",
    "  test('should log in with valid credentials', async ({ page }) => {",
    `    await page.goto('${appType.baseUrl}/login');`,
    "    await page.getByLabel('Email').fill('user@example.com');",
    "    await page.getByLabel('Password').fill('password123');",
    "    await page.getByRole('button', { name: 'Sign in' }).click();",
    `    await expect(page).toHaveURL('${appType.baseUrl}/dashboard');`,
    "  });",
    "});",
    "```",
    "",
  );

  // Step 3: Execution
  sections.push(
    "## Step 3: Execution",
    "",
    "Run the generated tests:",
    "",
    `1. Start the dev server:`,
    "```bash",
    `bash ${scriptsDir}/start-dev-server.sh "${options.cwd}" "${appType.devCommand}" ${appType.port} 60 "${sessionDir}"`,
    "```",
    "   Read the JSON output. If `ready: false`, stop and report the error.",
    "",
    "2. Run the tests — **IMPORTANT: never run playwright directly. Always use the script:**",
    "```bash",
    `bash ${scriptsDir}/run-e2e-tests.sh "${sessionDir}/tests" "${appType.baseUrl}"`,
    "```",
    "   Read the JSON output. It contains `total`, `passed`, `failed`, `failures[]`.",
    "",
    `3. If there are failures and retries remain (max ${execution.maxRetries}):`,
    "   - Read the `failures` array (do NOT read full test output)",
    "   - Analyze each failure: is it a test issue or a real app bug?",
    "   - If test issue: fix the test file and re-run",
    "   - If real app bug: note it for the report",
    "",
    "4. Stop the dev server:",
    "```bash",
    `bash ${scriptsDir}/stop-dev-server.sh "${sessionDir}"`,
    "```",
    "",
  );

  // Step 4: Regression Analysis & Reporting
  sections.push(
    "## Step 4: Regression Analysis & Reporting",
    "",
    "Compare results against the previous matrix to detect regressions:",
    "",
    "For each flow that was **passing** in the matrix but now **fails**:",
    "- This is a **regression** — record it in the ledger's `regressions` array:",
    '  `{ "flowId": "...", "flowName": "...", "previousStatus": "pass", "currentStatus": "fail", "error": "..." }`',
    "",
    `Update the persistent matrix at \`${dotDirDisplay}/supipowers/e2e-matrix.json\`:`,
    "- Update `lastStatus` and `lastTestedAt` for each tested flow",
    "- Add new flows with `lastStatus: \"untested\"` and `addedAt` timestamp",
    "- Mark removed flows with `removedAt` timestamp (don't delete them)",
    "",
    "Write the final report to the session ledger:",
    "- Total flows tested, passed, failed",
    "- List of regressions (if any)",
    "- List of new flows discovered",
    "- Coverage summary",
    "",
    `Update the session ledger at \`${sessionDir}/ledger.json\` with results and mark all phases completed.`,
    "",
  );

  // Script paths
  sections.push(
    "## Script Paths",
    "",
    `- detect-app-type.sh: \`${scriptsDir}/detect-app-type.sh\``,
    `- discover-routes.sh: \`${scriptsDir}/discover-routes.sh\``,
    `- start-dev-server.sh: \`${scriptsDir}/start-dev-server.sh\``,
    `- run-e2e-tests.sh: \`${scriptsDir}/run-e2e-tests.sh\``,
    `- stop-dev-server.sh: \`${scriptsDir}/stop-dev-server.sh\``,
    "",
  );

  // Token guidance
  sections.push(
    "## Token Guidance",
    "",
    "To minimize token usage:",
    "- Always use `run-e2e-tests.sh` — never run playwright directly",
    "- Only read the `failures` array from test results, skip passed tests",
    "- Don't cat full test files when analyzing failures — read only the failing line range",
    "- Write tests incrementally by flow group, run after each group to catch issues early",
    "- Don't dump raw playwright output — the script produces a compact JSON summary",
    "",
  );

  return sections.join("\n");
}
