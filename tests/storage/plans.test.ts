import { describe, test, expect } from "vitest";
import { parsePlan } from "../../src/storage/plans.js";

const SAMPLE_PLAN = `---
name: auth-refactor
created: 2026-03-10
tags: [auth, api]
---

# Auth Refactor

## Context
Refactoring the auth module for better separation.

## Tasks

### 1. Extract middleware [parallel-safe]
- **files**: src/middleware/auth.ts, src/middleware/index.ts
- **criteria**: Auth logic extracted, existing tests pass
- **complexity**: small

### 2. Add JWT validation [sequential: depends on 1]
- **files**: src/middleware/auth.ts, src/utils/jwt.ts
- **criteria**: JWT tokens validated, unit tests added
- **complexity**: medium
`;

describe("parsePlan", () => {
  test("parses frontmatter", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.name).toBe("auth-refactor");
    expect(plan.created).toBe("2026-03-10");
    expect(plan.tags).toEqual(["auth", "api"]);
  });

  test("extracts context", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.context).toBe("Refactoring the auth module for better separation.");
  });

  test("parses tasks", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks).toHaveLength(2);
  });

  test("parses files list", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].files).toEqual(["src/middleware/auth.ts", "src/middleware/index.ts"]);
  });

  test("parses complexity", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].complexity).toBe("small");
    expect(plan.tasks[1].complexity).toBe("medium");
  });

  test("parses criteria", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].criteria).toBe("Auth logic extracted, existing tests pass");
  });

  test("parses 'Task N:' header format", () => {
    const plan = parsePlan(
      `---
name: test
created: 2026-03-15
tags: []
---

## Context
Some context.

### Task 1: Add new types [parallel-safe]
- **files**: src/types.ts
- **criteria**: Types compile
- **complexity**: small

### Task 2: Create detector [sequential: depends on 1]
- **files**: src/detector.ts
- **criteria**: Detector works
- **complexity**: medium
`,
      "task-format.md",
    );
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].id).toBe(1);
    expect(plan.tasks[0].name).toBe("Add new types");
    expect(plan.tasks[0].files).toEqual(["src/types.ts"]);
    expect(plan.tasks[1].id).toBe(2);
  });

  test("ignores task headers inside fenced code blocks", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Example plan.

### Task 1: Real task [parallel-safe]
- **files**: src/real.ts

Here is an example:

\`\`\`markdown
### Task 2: Fake task inside code block [parallel-safe]
- **files**: src/fake.ts
\`\`\`

### Task 2: Another real task [sequential: depends on 1]
- **files**: src/another.ts
`,
      "code-block.md",
    );
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].name).toBe("Real task");
    expect(plan.tasks[1].name).toBe("Another real task");
    expect(plan.tasks[1].id).toBe(2);
  });

  test("parses multi-line file list with action prefixes", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### Task 1: Update types [parallel-safe]

**Files:**
- Modify: \`src/types.ts\`
- Create: \`src/new-file.ts\`
- Test: \`tests/types.test.ts\`
`,
      "multiline-files.md",
    );
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].files).toEqual([
      "src/types.ts",
      "src/new-file.ts",
      "tests/types.test.ts",
    ]);
  });

  test("parses colon-inside-bold fields (**Criteria:** and **Complexity:**)", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### Task 1: Do something [parallel-safe]
- **Criteria:** All tests pass
- **Complexity:** large
`,
      "bold-colon.md",
    );
    expect(plan.tasks[0].criteria).toBe("All tests pass");
    expect(plan.tasks[0].complexity).toBe("large");
  });

  test("returns empty tasks for plan with no task headers", () => {
    const plan = parsePlan(
      `---
name: empty
tags: []
---

## Context
No tasks here.

## Some other section
Just text.
`,
      "empty.md",
    );
    expect(plan.tasks).toHaveLength(0);
  });

  test("handles mixed header formats in the same plan", () => {
    const plan = parsePlan(
      `---
name: mixed
tags: []
---

## Context
Mixed.

### 1. Old-style task [parallel-safe]
- **files**: src/old.ts

### Task 2: New-style task [sequential: depends on 1]

**Files:**
- Modify: \`src/new.ts\`
`,
      "mixed.md",
    );
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].id).toBe(1);
    expect(plan.tasks[0].files).toEqual(["src/old.ts"]);
    expect(plan.tasks[1].id).toBe(2);
    expect(plan.tasks[1].files).toEqual(["src/new.ts"]);
  });

  test("strips parenthetical notes from file paths", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### Task 1: Files with notes [parallel-safe]

**Files:**
- Modify: \`src/types.ts\`
- Test: \`tests/config/loader.test.ts\` (existing — verify merge still works)
`,
      "notes.md",
    );
    expect(plan.tasks[0].files).toEqual([
      "src/types.ts",
      "tests/config/loader.test.ts",
    ]);
  });

  test("does not match #### sub-headers as tasks", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### Task 1: Real task [parallel-safe]

#### Sub-detail 2. Not a task

Some content.
`,
      "sub-headers.md",
    );
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].name).toBe("Real task");
  });

  test("parses [model: ...] annotation from task header", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### Task 1: Implement auth [parallel-safe] [model: claude-opus-4-6]
- **files**: src/auth.ts
- **criteria**: Auth works
- **complexity**: medium
`,
      "model-annotation.md",
    );
    expect(plan.tasks[0].model).toBe("claude-opus-4-6");
    expect(plan.tasks[0].name).toBe("Implement auth");
  });

  test("model annotation is undefined when not present", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].model).toBeUndefined();
    expect(plan.tasks[1].model).toBeUndefined();
  });

  test("parses model annotation with provider/model format", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### 1. Complex task [model: anthropic/claude-opus-4-6] [sequential: depends on 0]
- **files**: src/complex.ts
`,
      "provider-model.md",
    );
    expect(plan.tasks[0].model).toBe("anthropic/claude-opus-4-6");
    expect(plan.tasks[0].name).toBe("Complex task");
  });

  test("parses model annotation as only annotation", () => {
    const plan = parsePlan(
      `---
name: test
tags: []
---

## Context
Test.

### Task 1: Simple task [model: gpt-4o]
- **files**: src/simple.ts
`,
      "model-only.md",
    );
    expect(plan.tasks[0].model).toBe("gpt-4o");
    expect(plan.tasks[0].name).toBe("Simple task");
  });
});
