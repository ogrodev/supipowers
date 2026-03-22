
export interface PlanWriterOptions {
  specPath: string;
  dotDirDisplay: string;
}

/**
 * Build the plan writing prompt that guides the agent through creating
 * a comprehensive implementation plan from an approved spec.
 *
 * Follows supipowers' writing-plans skill:
 * - Scope check
 * - File structure mapping
 * - Bite-sized tasks with TDD steps
 * - Plan review loop per chunk
 * - Execution handoff
 */
export function buildPlanWriterPrompt(options: PlanWriterOptions): string {
  const { specPath, dotDirDisplay } = options;

  const sections: string[] = [
    "You are writing a comprehensive implementation plan from an approved design spec.",
    "",
    `**Spec document:** ${specPath}`,
    "",
    "Write the plan assuming the implementing engineer has zero context for this codebase.",
    "Document everything they need: which files to touch, complete code, testing, exact commands.",
    "Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.",
    "",

    // ── Scope Check ──────────────────────────────────────────────
    "## Scope Check",
    "",
    "If the spec covers multiple independent subsystems, suggest breaking into separate plans.",
    "Each plan should produce working, testable software on its own.",
    "",

    // ── File Structure ───────────────────────────────────────────
    "## Step 1: Map file structure",
    "",
    "Before defining tasks, map out which files will be created or modified and what each one is responsible for.",
    "This is where decomposition decisions get locked in.",
    "",
    "- Each file should have one clear responsibility with a well-defined interface",
    "- Prefer smaller, focused files over large ones that do too much",
    "- Files that change together should live together — split by responsibility, not by technical layer",
    "- In existing codebases, follow established patterns",
    "",

    // ── Plan Header ──────────────────────────────────────────────
    "## Step 2: Write Plan Document",
    "",
    "Every plan MUST start with this header:",
    "",
    "```markdown",
    "# [Feature Name] Implementation Plan",
    "",
    "**Goal:** [One sentence describing what this builds]",
    "",
    "**Architecture:** [2-3 sentences about approach]",
    "",
    "**Tech Stack:** [Key technologies/libraries]",
    "",
    "---",
    "```",
    "",

    // ── Task Granularity ─────────────────────────────────────────
    "## Step 3: Define Bite-Sized Tasks",
    "",
    "Each step is one action (2-5 minutes):",
    "- Write the failing test — one step",
    "- Run it to verify it fails — one step",
    "- Write minimal implementation — one step",
    "- Run tests to verify it passes — one step",
    "- Commit — one step",
    "",

    // ── Task Structure ───────────────────────────────────────────
    "### Task Structure Template",
    "",
    "````markdown",
    "### Task N: [Component Name]",
    "",
    "**Files:**",
    "- Create: `exact/path/to/file.ts`",
    "- Modify: `exact/path/to/existing.ts:123-145`",
    "- Test: `tests/exact/path/to/test.ts`",
    "",
    "- [ ] **Step 1: Write the failing test**",
    "",
    "```typescript",
    "test('specific behavior', () => {",
    "  const result = myFunction(input);",
    "  expect(result).toBe(expected);",
    "});",
    "```",
    "",
    "- [ ] **Step 2: Run test to verify it fails**",
    "",
    "Run: `npx vitest run tests/path/test.ts`",
    'Expected: FAIL with "myFunction is not defined"',
    "",
    "- [ ] **Step 3: Write minimal implementation**",
    "",
    "```typescript",
    "export function myFunction(input: string): string {",
    "  return expected;",
    "}",
    "```",
    "",
    "- [ ] **Step 4: Run test to verify it passes**",
    "",
    "Run: `npx vitest run tests/path/test.ts`",
    "Expected: PASS",
    "",
    "- [ ] **Step 5: Commit**",
    "",
    "```bash",
    "git add tests/path/test.ts src/path/file.ts",
    'git commit -m "feat: add specific feature"',
    "```",
    "````",
    "",

    // ── Remember ─────────────────────────────────────────────────
    "### Requirements",
    "",
    "- Exact file paths always",
    "- Complete code in plan (not 'add validation' — show the actual code)",
    "- Exact commands with expected output",
    "- DRY, YAGNI, TDD, frequent commits",
    "",

    // ── Plan Review Loop ─────────────────────────────────────────
    "## Step 4: plan review loop",
    "",
    "After completing each chunk of the plan, dispatch a plan-document-reviewer sub-agent.",
    "",
    "Use `## Chunk N: <name>` headings to delimit chunks. Each chunk should be under 1000 lines and logically self-contained.",
    "",
    "1. Dispatch a plan-document-reviewer sub-agent for each chunk.",
    "   The reviewer checks: completeness, spec alignment, task decomposition,",
    "   file structure, file size rules, checkbox syntax, and chunk size.",
    "   Provide the reviewer with: the plan file path, the spec file path, and the chunk number.",

    "",
    "2. If **Issues Found**: fix the issues, re-dispatch the reviewer",
    "3. Repeat until **Approved** (max 5 iterations, then surface to human for guidance)",
    "4. Proceed to next chunk or execution handoff",
    "",

    // ── Save Location ────────────────────────────────────────────
    "## Step 5: Save Plan",
    "",
    `Save the plan to \`${dotDirDisplay}/supipowers/plans/YYYY-MM-DD-<feature-name>.md\``,
    "",

    // ── Execution Handoff ────────────────────────────────────────
    "## Step 6: Execution Handoff",
    "",
    "After saving the plan, ask:",
    "",
    '> "Plan complete and saved to `<path>`. Ready to execute?"',
    "",
    "Wait for user confirmation before proceeding to execution.",
    "",
  ];

  return sections.join("\n");
}
