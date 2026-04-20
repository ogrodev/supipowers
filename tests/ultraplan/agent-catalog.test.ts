import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPaths } from "../../src/platform/types.js";
import { ULTRAPLAN_AGENT_SLOT_NAMES } from "../../src/ultraplan/contracts.js";
import {
  getGlobalUltraPlanAgentsDir,
  loadBuiltInUltraPlanAgentDefinitions,
  loadGlobalUltraPlanAgentDefinitions,
  loadUltraPlanAgentCatalog,
  parseUltraPlanAgentMarkdown,
} from "../../src/ultraplan/agent-catalog.js";

let tmpDir: string;
let projectDir: string;
let paths: ReturnType<typeof createPaths>;

function writeGlobalAgent(fileName: string, content: string): void {
  const dir = getGlobalUltraPlanAgentsDir(paths);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

function writeGlobalConfig(data: unknown): void {
  const filePath = paths.global("config.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeProjectConfig(data: unknown): void {
  const filePath = paths.project(projectDir, "config.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function expectCatalogSuccess(result: ReturnType<typeof loadUltraPlanAgentCatalog>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected successful catalog resolution, got: ${JSON.stringify(result.errors)}`);
  }

  return result.value;
}

function expectCatalogFailure(result: ReturnType<typeof loadUltraPlanAgentCatalog>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected catalog resolution to fail");
  }

  return result.errors;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-agent-catalog-"));
  projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  paths = {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(tmpDir, "global-config", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
  };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ultraplan built-in agent assets", () => {
  test("built-in assets define every reserved slot 1:1", () => {
    const definitions = loadBuiltInUltraPlanAgentDefinitions();

    expect(definitions).toHaveLength(ULTRAPLAN_AGENT_SLOT_NAMES.length);
    expect(definitions.map((definition) => definition.name).sort()).toEqual(
      [...ULTRAPLAN_AGENT_SLOT_NAMES].sort(),
    );
    expect(
      definitions.every(
        (definition) =>
          definition.source === "built-in"
          && definition.supportedSlots.length === 1
          && definition.supportedSlots[0] === definition.name
          && definition.description.length > 0
          && definition.prompt.length > 0,
      ),
    ).toBe(true);
  });
});

describe("ultraplan catalog loading", () => {
  test("parse helper reads UltraPlan frontmatter and prompt bodies", () => {
    const definition = parseUltraPlanAgentMarkdown(
      [
        "---",
        "name: frontend-executor",
        "description: Frontend implementation agent",
        "supportedSlots:",
        "  - frontend-executor",
        "thinkingLevel: low",
        "---",
        "",
        "Implement frontend work with discipline.",
        "",
      ].join("\n"),
      "frontend-executor.md",
      "built-in",
    );

    expect(definition).toMatchObject({
      name: "frontend-executor",
      source: "built-in",
      supportedSlots: ["frontend-executor"],
      thinkingLevel: "low",
    });
    expect(definition.prompt.length).toBeGreaterThan(0);
  });


  test("loads custom global UltraPlan definitions", () => {
    writeGlobalAgent(
      "integration-breaker.md",
      [
        "---",
        "name: integration-breaker",
        "description: Adversarial integration and regression tester",
        "supportedSlots:",
        "  - backend-tester",
        "  - infrastructure-tester",
        "model: anthropic/claude-sonnet-4-20250514",
        "thinkingLevel: low",
        "focus: integration failures, regression pressure",
        "---",
        "",
        "Attack the integration surface and make regressions obvious.",
        "",
      ].join("\n"),
    );

    const definitions = loadGlobalUltraPlanAgentDefinitions(paths);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      name: "integration-breaker",
      source: "global",
      supportedSlots: ["backend-tester", "infrastructure-tester"],
    });
  });

  test("rejects duplicate global UltraPlan names", () => {
    writeGlobalAgent(
      "integration-breaker-a.md",
      "---\nname: integration-breaker\ndescription: First definition\nsupportedSlots:\n  - backend-tester\n---\n\nfirst\n",
    );
    writeGlobalAgent(
      "integration-breaker-b.md",
      "---\nname: integration-breaker\ndescription: Second definition\nsupportedSlots:\n  - infrastructure-tester\n---\n\nsecond\n",
    );

    expect(() => loadGlobalUltraPlanAgentDefinitions(paths)).toThrow(
      /Duplicate UltraPlan agent name "integration-breaker"/,
    );
  });

  test("rejects global names that reuse reserved built-in names", () => {
    writeGlobalAgent(
      "frontend-executor.md",
      "---\nname: frontend-executor\ndescription: Illegal collision\nsupportedSlots:\n  - frontend-executor\n---\n\ncollision\n",
    );

    expect(() => loadGlobalUltraPlanAgentDefinitions(paths)).toThrow(
      /reserved built-in name/,
    );
  });

  test("top-level catalog load blocks the catalog when a global definition is invalid", () => {
    writeGlobalAgent("integration-breaker.md", "not yaml frontmatter\n\nbody\n");
    writeProjectConfig({
      ultraplan: {
        slots: {
          "backend-tester": {
            agentName: "integration-breaker",
          },
        },
      },
    });

    const result = loadUltraPlanAgentCatalog(paths, projectDir);
    const errors = expectCatalogFailure(result);

    expect(Object.values(result.value.slots).every((binding) => binding === null)).toBe(true);
    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: null,
        code: "invalid-agent-definition",
        path: expect.stringContaining("integration-breaker.md"),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: "backend-tester",
        code: "required-slot-unresolved",
      }),
    );
  });

  test("top-level catalog load returns structured duplicate-name errors", () => {
    writeGlobalAgent(
      "integration-breaker-a.md",
      "---\nname: integration-breaker\ndescription: First definition\nsupportedSlots:\n  - backend-tester\n---\n\nfirst\n",
    );
    writeGlobalAgent(
      "integration-breaker-b.md",
      "---\nname: integration-breaker\ndescription: Second definition\nsupportedSlots:\n  - infrastructure-tester\n---\n\nsecond\n",
    );

    const errors = expectCatalogFailure(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: null,
        code: "duplicate-agent-name",
        path: expect.stringContaining("integration-breaker-b.md"),
      }),
    );
  });

  test("top-level catalog load returns a blocked catalog on config errors instead of throwing", () => {
    writeGlobalConfig({
      ultraplan: {
        slots: {
          "backend-tester": {
            agentName: "integration-breaker",
          },
        },
      },
    });

    const result = loadUltraPlanAgentCatalog(paths, projectDir);
    const errors = expectCatalogFailure(result);

    expect(Object.values(result.value.slots).every((binding) => binding === null)).toBe(true);
    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: null,
        code: "invalid-config",
        path: paths.global("config.json"),
        message: expect.stringContaining("Only repository config may define ultraplan"),
      }),
    );
  });

  test("top-level catalog load preserves repository config paths on validation errors", () => {
    writeProjectConfig({
      ultraplan: {
        slots: {
          "backend-tester": {
            thinkingLevel: "unsupported",
          },
        },
      },
    });

    const result = loadUltraPlanAgentCatalog(paths, projectDir);
    const errors = expectCatalogFailure(result);

    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: null,
        code: "invalid-config",
        path: paths.project(projectDir, "config.json"),
        message: expect.stringContaining("ultraplan.slots.backend-tester.thinkingLevel"),
      }),
    );
  });
});

describe("ultraplan catalog resolution", () => {
  test("uses built-in fallback bindings when the repo does not override a slot", () => {
    const catalog = expectCatalogSuccess(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(catalog.slots["frontend-executor"]).toMatchObject({
      slot: "frontend-executor",
      agentType: "built-in",
      agentName: "frontend-executor",
      selectionSource: "default",
      definitionSource: "built-in",
      modelSource: "unset",
      thinkingLevelSource: "unset",
    });
    expect(catalog.reviewGates).toEqual({});
  });

  test("binds a repo slot override to a named global definition", () => {
    writeGlobalAgent(
      "integration-breaker.md",
      [
        "---",
        "name: integration-breaker",
        "description: Adversarial integration and regression tester",
        "supportedSlots:",
        "  - backend-tester",
        "model: anthropic/claude-sonnet-4-20250514",
        "thinkingLevel: low",
        "---",
        "",
        "Push hard on integration behavior.",
        "",
      ].join("\n"),
    );
    writeProjectConfig({
      ultraplan: {
        slots: {
          "backend-tester": {
            agentName: "integration-breaker",
          },
        },
      },
    });

    const catalog = expectCatalogSuccess(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(catalog.slots["backend-tester"]).toMatchObject({
      slot: "backend-tester",
      agentType: "named",
      agentName: "integration-breaker",
      selectionSource: "project",
      definitionSource: "global",
      model: "anthropic/claude-sonnet-4-20250514",
      modelSource: "global",
      thinkingLevel: "low",
      thinkingLevelSource: "global",
    });
  });

  test("applies project model and thinking overrides after built-in selection", () => {
    writeProjectConfig({
      ultraplan: {
        slots: {
          "frontend-executor": {
            model: "openai/gpt-5",
            thinkingLevel: "high",
          },
        },
      },
    });

    const catalog = expectCatalogSuccess(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(catalog.slots["frontend-executor"]).toMatchObject({
      agentName: "frontend-executor",
      selectionSource: "default",
      definitionSource: "built-in",
      model: "openai/gpt-5",
      modelSource: "project",
      thinkingLevel: "high",
      thinkingLevelSource: "project",
    });
  });

  test("emits reviewer gate policy for reviewer slots only", () => {
    writeProjectConfig({
      ultraplan: {
        reviewGates: {
          "backend-domain-reviewer": {
            enabled: false,
          },
        },
      },
    });

    const catalog = expectCatalogSuccess(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(catalog.reviewGates).toEqual({
      "backend-domain-reviewer": {
        enabled: false,
      },
    });
  });
});

describe("ultraplan catalog required and disabled semantics", () => {
  test("fails closed when a required executor override cannot be resolved", () => {
    writeProjectConfig({
      ultraplan: {
        slots: {
          "frontend-executor": {
            agentName: "missing-executor",
          },
        },
      },
    });

    const result = loadUltraPlanAgentCatalog(paths, projectDir);
    const errors = expectCatalogFailure(result);

    expect(Object.values(result.value.slots).every((binding) => binding === null)).toBe(true);
    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: "frontend-executor",
        code: "required-slot-unresolved",
      }),
    );
  });

  test("fails closed when a required tester override cannot be resolved", () => {
    writeProjectConfig({
      ultraplan: {
        slots: {
          "backend-tester": {
            agentName: "missing-tester",
          },
        },
      },
    });

    const errors = expectCatalogFailure(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: "backend-tester",
        code: "required-slot-unresolved",
      }),
    );
  });

  test("does not require reviewers disabled by project policy", () => {
    writeProjectConfig({
      ultraplan: {
        slots: {
          "backend-domain-reviewer": {
            agentName: "missing-reviewer",
          },
        },
        reviewGates: {
          "backend-domain-reviewer": {
            enabled: false,
          },
        },
      },
    });

    const result = loadUltraPlanAgentCatalog(paths, projectDir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected disabled reviewer resolution to succeed");
    }
    expect(result.value.slots["backend-domain-reviewer"]).toBeNull();
    expect(result.value.reviewGates["backend-domain-reviewer"]).toEqual({ enabled: false });
  });

  test("fails when an enabled reviewer cannot be resolved", () => {
    writeProjectConfig({
      ultraplan: {
        slots: {
          "backend-stack-reviewer": {
            agentName: "missing-reviewer",
          },
        },
        reviewGates: {
          "backend-stack-reviewer": {
            enabled: true,
          },
        },
      },
    });

    const errors = expectCatalogFailure(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: "backend-stack-reviewer",
        code: "required-slot-unresolved",
      }),
    );
  });

  test("fails when a selected definition does not support the requested slot", () => {
    writeGlobalAgent(
      "review-only.md",
      [
        "---",
        "name: review-only",
        "description: Reviewer-only agent",
        "supportedSlots:",
        "  - backend-domain-reviewer",
        "---",
        "",
        "Review backend domain changes only.",
        "",
      ].join("\n"),
    );
    writeProjectConfig({
      ultraplan: {
        slots: {
          "frontend-executor": {
            agentName: "review-only",
          },
        },
      },
    });

    const errors = expectCatalogFailure(loadUltraPlanAgentCatalog(paths, projectDir));

    expect(errors).toContainEqual(
      expect.objectContaining({
        slot: "frontend-executor",
        code: "unsupported-slot",
      }),
    );
  });
});
