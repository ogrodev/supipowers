import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ULTRAPLAN_AUTHORING_AGENTS_DIRNAME,
  loadUltraPlanAuthoringCatalog,
  resolveAuthoringSlot,
} from "../../../src/ultraplan/authoring/agent-catalog.js";
import { ULTRAPLAN_AUTHORING_SLOT_NAMES } from "../../../src/ultraplan/contracts.js";
import { createTestPaths, createTestRepo } from "../fixtures.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-authoring-catalog-"));
  paths = createTestPaths(tmpDir);
  const repo = createTestRepo(tmpDir);
  cwd = repo.repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("authoring catalog — built-in resolution", () => {
  test("every authoring slot resolves to a built-in definition by default", () => {
    const result = loadUltraPlanAuthoringCatalog(paths, cwd);
    expect(result.ok).toBe(true);
    expect(result.errors.length).toBe(0);
    for (const slot of ULTRAPLAN_AUTHORING_SLOT_NAMES) {
      const binding = result.value.slots[slot];
      expect(binding).toBeDefined();
      expect(binding.slot).toBe(slot);
      expect(binding.definition.source).toBe("built-in");
      expect(binding.definition.name).toBe(slot);
      expect(binding.definition.supportedSlots).toContain(slot);
      expect(binding.definition.prompt.length).toBeGreaterThan(0);
    }
  });

  test("resolveAuthoringSlot returns the binding directly", () => {
    const binding = resolveAuthoringSlot("planner", paths, cwd);
    expect(binding.slot).toBe("planner");
    expect(binding.definition.name).toBe("planner");
  });
});

describe("authoring catalog — global override", () => {
  function writeGlobalOverride(slot: string, content: string) {
    const dir = paths.global(ULTRAPLAN_AUTHORING_AGENTS_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slot}.md`), content);
  }

  test("a valid global override replaces the built-in for one slot only", () => {
    writeGlobalOverride(
      "planner",
      [
        "---",
        "name: planner",
        "description: Custom planner",
        "supportedSlots:",
        "  - planner",
        "focus: custom",
        "---",
        "Custom planner body.",
        "",
      ].join("\n"),
    );

    const result = loadUltraPlanAuthoringCatalog(paths, cwd);
    expect(result.ok).toBe(true);

    const planner = result.value.slots.planner.definition;
    expect(planner.source).toBe("global");
    expect(planner.prompt.includes("Custom planner body")).toBe(true);

    // Other slots stay built-in.
    expect(result.value.slots.intake.definition.source).toBe("built-in");
    expect(result.value.slots.scout.definition.source).toBe("built-in");
  });

  test("malformed override produces a structured catalog error and falls back to built-in", () => {
    writeGlobalOverride("planner", "no frontmatter at all");

    const result = loadUltraPlanAuthoringCatalog(paths, cwd);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.code).toBe("invalid-agent-definition");

    // Fallback: planner still resolves to built-in.
    expect(result.value.slots.planner.definition.source).toBe("built-in");
  });

  test("override that references a wrong supportedSlot value is rejected", () => {
    writeGlobalOverride(
      "planner",
      [
        "---",
        "name: planner",
        "description: x",
        "supportedSlots:",
        "  - not-a-real-slot",
        "---",
        "Body",
        "",
      ].join("\n"),
    );

    const result = loadUltraPlanAuthoringCatalog(paths, cwd);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.code).toBe("invalid-agent-definition");
  });
});

describe("authoring catalog — project override beats global", () => {
  function writeProjectOverride(slot: string, content: string) {
    const dir = paths.project(cwd, ULTRAPLAN_AUTHORING_AGENTS_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slot}.md`), content);
  }
  function writeGlobalOverride(slot: string, content: string) {
    const dir = paths.global(ULTRAPLAN_AUTHORING_AGENTS_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slot}.md`), content);
  }

  test("project override wins over global override", () => {
    writeGlobalOverride(
      "researcher",
      [
        "---",
        "name: researcher",
        "description: Global",
        "supportedSlots:",
        "  - researcher",
        "---",
        "Global body",
        "",
      ].join("\n"),
    );
    writeProjectOverride(
      "researcher",
      [
        "---",
        "name: researcher",
        "description: Project",
        "supportedSlots:",
        "  - researcher",
        "---",
        "Project body",
        "",
      ].join("\n"),
    );

    const result = loadUltraPlanAuthoringCatalog(paths, cwd);
    expect(result.value.slots.researcher.definition.source).toBe("project");
    expect(result.value.slots.researcher.definition.prompt.includes("Project body")).toBe(true);
  });
});
