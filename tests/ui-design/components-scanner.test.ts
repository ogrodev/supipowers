import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { scanExistingComponents } from "../../src/ui-design/components-scanner.js";

const FIXTURES = path.resolve(import.meta.dir, "..", "fixtures", "ui-design");

describe("components scanner", () => {
  test("discovers react component, excludes test/stories/dist", async () => {
    const result = await scanExistingComponents(path.join(FIXTURES, "react-components"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      name: "Button",
      path: "components/Button.tsx",
      framework: "react",
      exports: ["Button"],
    });
  });

  test("detects vue framework", async () => {
    const result = await scanExistingComponents(path.join(FIXTURES, "vue-components"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.framework).toBe("vue");
    expect(result.items[0]!.path).toBe("components/Card.vue");
  });

  test("detects svelte framework under src/components", async () => {
    const result = await scanExistingComponents(path.join(FIXTURES, "svelte-components"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.framework).toBe("svelte");
  });

  test("returns missing when no components", async () => {
    const result = await scanExistingComponents(path.join(FIXTURES, "no-design-system"));
    expect(result.status).toBe("missing");
    expect(result.items).toEqual([]);
  });

  test("honors custom globs override", async () => {
    const result = await scanExistingComponents(path.join(FIXTURES, "react-components"), {
      globs: ["dist/**/*.{tsx,jsx}"],
      excludes: [],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.path).toBe("dist/Compiled.tsx");
  });

  test("normalizes discovered repo-relative paths before excludes and output", async () => {
    const originalScan = Bun.Glob.prototype.scan;
    Object.defineProperty(Bun.Glob.prototype, "scan", {
      configurable: true,
      value: async function* scanWithWindowsSeparators() {
        yield "components\\Button.tsx";
        yield "dist\\Compiled.tsx";
      },
    });

    try {
      const result = await scanExistingComponents(path.join(FIXTURES, "react-components"));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.items).toEqual([
        {
          name: "Button",
          path: "components/Button.tsx",
          framework: "react",
          exports: ["Button"],
        },
      ]);
    } finally {
      Object.defineProperty(Bun.Glob.prototype, "scan", {
        configurable: true,
        value: originalScan,
      });
    }
  });
});
