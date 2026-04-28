import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthoringDependencies } from "../../src/ultraplan/authoring-wizard.js";
import { persistAuthoredUltraPlanSession } from "../../src/ultraplan/authoring-persist.js";
import {
  createUltraPlanFromAuthoringToolInput,
  registerUltraPlanAuthoringTool,
} from "../../src/ultraplan/authoring-tool.js";
import { getUltraplanAuthoredJsonPath, getUltraplanManifestPath } from "../../src/ultraplan/project-paths.js";
import { createTestPaths, createTestRepo, makeCatalogFixture } from "./fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-authoring-tool-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function deps(overrides: Partial<AuthoringDependencies> = {}): AuthoringDependencies {
  return {
    now: () => new Date("2026-04-22T10:00:00.000Z"),
    newSessionId: () => "up-tool",
    loadCatalog: () => ({ ok: true, value: makeCatalogFixture() }),
    persist: persistAuthoredUltraPlanSession,
    ...overrides,
  };
}

describe("createUltraPlanFromAuthoringToolInput", () => {
  test("persists an inferred plan and marks omitted stacks not-applicable", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const platform = { paths } as any;

    const result = createUltraPlanFromAuthoringToolInput({
      platform,
      cwd,
      deps: deps(),
      params: {
        title: "Checkout mobile",
        goal: "Users can complete checkout on mobile",
        stacks: [
          {
            stack: "frontend",
            domains: [
              {
                name: "Checkout UI",
                unit: [
                  { title: "Cart summary renders selected items", steps: ["Render filled cart", "Assert totals"] },
                  { title: "Cart summary renders selected items" },
                ],
                e2e: [{ title: "Mobile user completes checkout" }],
              },
            ],
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe("up-tool");

    const authored = JSON.parse(fs.readFileSync(getUltraplanAuthoredJsonPath(paths, cwd, "up-tool"), "utf8"));
    expect(authored.title).toBe("Checkout mobile");
    expect(authored.stacks.find((stack: any) => stack.stack === "frontend")?.applicability).toBe("applicable");
    expect(authored.stacks.find((stack: any) => stack.stack === "backend")?.applicability).toBe("not-applicable");
    expect(authored.stacks.find((stack: any) => stack.stack === "infrastructure")?.applicability).toBe("not-applicable");

    const domain = authored.stacks[0].domains[0];
    expect(domain.id).toBe("checkout-ui");
    expect(domain.unit.map((scenario: any) => scenario.id)).toEqual([
      "cart-summary-renders-selected-items",
      "cart-summary-renders-selected-items-2",
    ]);
    expect(domain.unit[0].steps).toEqual(["Render filled cart", "Assert totals"]);
    expect(domain.e2e[0].assignedSlots).toEqual(["frontend-tester", "frontend-executor"]);

    const manifest = JSON.parse(fs.readFileSync(getUltraplanManifestPath(paths, cwd, "up-tool"), "utf8"));
    expect(manifest.cursor.summary).toBe("Cart summary renders selected items");
    expect(manifest.progress.total).toBe(3);
  });

  test("rejects incomplete tool input before persisting", () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const persist = mock(() => ({ ok: true as const, authoredPath: "/a", manifestPath: "/m", indexPath: "/i", reclaimed: false }));

    const result = createUltraPlanFromAuthoringToolInput({
      platform: { paths } as any,
      cwd,
      deps: deps({ persist }),
      params: {
        title: "Incomplete",
        goal: "Missing scenarios",
        stacks: [{ stack: "frontend", domains: [{ name: "Empty domain" }] }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("must include at least one scenario");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("registerUltraPlanAuthoringTool", () => {
  test("registers ultraplan_create and writes through the tool context cwd", async () => {
    const paths = createTestPaths(tmpDir);
    const cwd = createTestRepo(tmpDir).repoRoot;
    const registerTool = mock((definition: any) => definition);
    const platform = { paths, registerTool } as any;

    registerUltraPlanAuthoringTool(platform);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const definition = registerTool.mock.calls[0][0] as any;
    expect(definition.name).toBe("ultraplan_create");

    const result = await definition.execute(
      "tool-call-1",
      {
        title: "Backend auth",
        goal: "API clients can authenticate",
        stacks: [{ stack: "backend", domains: [{ name: "Auth API", scenarios: [{ title: "Token endpoint validates credentials", level: "integration" }] }] }],
      },
      new AbortController().signal,
      undefined,
      { cwd },
    );

    expect(result.content[0].text).toContain("UltraPlan session saved");
    expect(result.details.sessionId).toMatch(/^ultraplan-/);
  });
});
