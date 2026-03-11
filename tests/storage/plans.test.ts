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

  test("parses parallel-safe annotation", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].parallelism).toEqual({ type: "parallel-safe" });
  });

  test("parses sequential annotation with dependencies", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[1].parallelism).toEqual({ type: "sequential", dependsOn: [1] });
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
});
