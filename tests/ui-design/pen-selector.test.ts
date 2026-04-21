import { describe, expect, mock, test } from "bun:test";
import * as path from "node:path";
import { selectPenFile } from "../../src/ui-design/pen-selector.js";
import type { PenFileEntry } from "../../src/ui-design/pen-scanner.js";

function entry(relativePath: string, absolutePath: string, bytes: number): PenFileEntry {
  return { relativePath, absolutePath, bytes };
}

describe("selectPenFile", () => {
  test("returns 'new' in the session dir when scan yields no entries", async () => {
    const select = mock(async () => null);
    const result = await selectPenFile({
      ctx: { hasUI: true, ui: { select } },
      repoRoot: "/repo",
      sessionDir: "/sess",
      scan: () => [],
    });
    expect(result).toEqual({ kind: "new", penFilePath: path.join("/sess", "design.pen") });
    expect(select).not.toHaveBeenCalled();
  });

  test("headless context with results: returns the first entry without prompting", async () => {
    const select = mock(async () => null);
    const scan = () => [
      entry("designs/a.pen", "/repo/designs/a.pen", 10),
      entry("designs/b.pen", "/repo/designs/b.pen", 20),
    ];
    const result = await selectPenFile({
      ctx: { hasUI: false },
      repoRoot: "/repo",
      sessionDir: "/sess",
      scan,
    });
    expect(result).toEqual({ kind: "existing", penFilePath: "/repo/designs/a.pen" });
    expect(select).not.toHaveBeenCalled();
  });

  test("user picks an existing .pen → returns that absolute path", async () => {
    const entries = [
      entry("designs/home.pen", "/repo/designs/home.pen", 100),
      entry("nested/checkout.pen", "/repo/nested/checkout.pen", 2048),
    ];
    const state: { offered: string[] | null } = { offered: null };
    const select = mock(async (_title: string, options: string[]) => {
      state.offered = options;
      return options[1]!; // pick checkout
    });
    const result = await selectPenFile({
      ctx: { hasUI: true, ui: { select } },
      repoRoot: "/repo",
      sessionDir: "/sess",
      scan: () => entries,
    });

    expect(state.offered).toEqual([
      "designs/home.pen (100 B)",
      "nested/checkout.pen (2.0 KB)",
      "Create a new .pen in the session directory",
    ]);
    expect(result).toEqual({ kind: "existing", penFilePath: "/repo/nested/checkout.pen" });
  });

  test("user picks 'Create a new' → returns session-local path", async () => {
    const entries = [entry("existing.pen", "/repo/existing.pen", 1)];
    const select = mock(async (_t: string, options: string[]) => options[options.length - 1]!);
    const result = await selectPenFile({
      ctx: { hasUI: true, ui: { select } },
      repoRoot: "/repo",
      sessionDir: "/sess",
      scan: () => entries,
    });
    expect(result).toEqual({ kind: "new", penFilePath: path.join("/sess", "design.pen") });
  });

  test("user cancels → returns null", async () => {
    const entries = [entry("existing.pen", "/repo/existing.pen", 1)];
    const select = mock(async () => null);
    const result = await selectPenFile({
      ctx: { hasUI: true, ui: { select } },
      repoRoot: "/repo",
      sessionDir: "/sess",
      scan: () => entries,
    });
    expect(result).toBeNull();
  });
});
