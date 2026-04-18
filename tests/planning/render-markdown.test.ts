import { describe, expect, test } from "bun:test";
import { renderPlanSpec } from "../../src/planning/render-markdown.js";
import type { PlanSpec } from "../../src/planning/spec.js";
import { parsePlan } from "../../src/storage/plans.js";
import { validatePlanSpec } from "../../src/planning/validate.js";

const SPEC: PlanSpec = {
  name: "feature-x",
  created: "2026-04-17",
  tags: ["refactor", "ai"],
  context: "Add feature X to the system so Y is possible.",
  tasks: [
    {
      id: 1,
      name: "Create the thing",
      description: "Create the thing",
      files: ["src/x.ts", "tests/x.test.ts"],
      criteria: "bun test tests/x.test.ts passes",
      complexity: "small",
    },
    {
      id: 2,
      name: "Wire it up",
      description: "Wire it up",
      files: ["src/bootstrap.ts"],
      criteria: "x is registered at bootstrap",
      complexity: "medium",
      model: "claude-opus-4-5",
    },
  ],
};

describe("renderPlanSpec — structural output", () => {
  test("includes YAML frontmatter, heading, context, and tasks", () => {
    const md = renderPlanSpec(SPEC);

    expect(md).toStartWith("---\n");
    expect(md).toContain("name: feature-x");
    expect(md).toContain("created: 2026-04-17");
    expect(md).toContain("tags: [refactor, ai]");
    expect(md).toContain("# feature-x");
    expect(md).toContain("## Context");
    expect(md).toContain("Add feature X to the system so Y is possible.");
    expect(md).toContain("## Tasks");
    expect(md).toContain("### Task 1: Create the thing");
    expect(md).toContain("### Task 2: Wire it up [model: claude-opus-4-5]");
    expect(md).toContain("**files**:");
    expect(md).toContain("- `src/x.ts`");
    expect(md).toContain("**criteria**: bun test tests/x.test.ts passes");
    expect(md).toContain("**complexity**: small");
  });

  test("renders deterministically for identical input", () => {
    expect(renderPlanSpec(SPEC)).toBe(renderPlanSpec(SPEC));
  });

  test("handles empty task list", () => {
    const md = renderPlanSpec({ ...SPEC, tasks: [] });
    expect(md).toContain("# feature-x");
    expect(md).not.toContain("### Task");
  });
});

describe("renderPlanSpec → parsePlan round-trip", () => {
  test("parser recovers task ids, names, files, criteria, complexity", () => {
    const md = renderPlanSpec(SPEC);
    const parsed = parsePlan(md, "/fake/feature-x.md");

    expect(parsed.name).toBe("feature-x");
    expect(parsed.tags).toEqual(["refactor", "ai"]);
    expect(parsed.context).toContain("Add feature X");
    expect(parsed.tasks.length).toBe(2);

    expect(parsed.tasks[0].id).toBe(1);
    expect(parsed.tasks[0].name).toBe("Create the thing");
    expect(parsed.tasks[0].files).toEqual(["src/x.ts", "tests/x.test.ts"]);
    expect(parsed.tasks[0].criteria).toBe("bun test tests/x.test.ts passes");
    expect(parsed.tasks[0].complexity).toBe("small");
    expect(parsed.tasks[0].model).toBeUndefined();

    expect(parsed.tasks[1].id).toBe(2);
    expect(parsed.tasks[1].name).toBe("Wire it up");
    expect(parsed.tasks[1].files).toEqual(["src/bootstrap.ts"]);
    expect(parsed.tasks[1].criteria).toBe("x is registered at bootstrap");
    expect(parsed.tasks[1].complexity).toBe("medium");
    expect(parsed.tasks[1].model).toBe("claude-opus-4-5");
  });

  test("parsed plan projects back into a valid PlanSpec", () => {
    const md = renderPlanSpec(SPEC);
    const parsed = parsePlan(md, "/fake/feature-x.md");
    // Project Plan → PlanSpec shape (drop filePath; match task field set).
    const spec = {
      name: parsed.name,
      created: parsed.created,
      tags: parsed.tags,
      context: parsed.context,
      tasks: parsed.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        files: t.files,
        criteria: t.criteria,
        complexity: t.complexity,
        ...(t.model ? { model: t.model } : {}),
      })),
    };
    const validated = validatePlanSpec(spec);
    expect(validated.error).toBeNull();
    expect(validated.output?.tasks.length).toBe(SPEC.tasks.length);
  });
});
