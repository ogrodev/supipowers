import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadPersistedViewMode } from "../../src/storage/view-mode-store";
import { getViewMode, setViewMode, toggleViewMode } from "../../src/ui/view-mode";

describe("supipowers view mode", () => {
  test("defaults to compact and toggles", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-view-mode-toggle-"));

    expect(getViewMode(cwd)).toBe("compact");
    expect(toggleViewMode(cwd)).toBe("full");
    expect(getViewMode(cwd)).toBe("full");
    expect(toggleViewMode(cwd)).toBe("compact");
  });

  test("supports explicit set and persists to disk", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-view-mode-persist-"));

    setViewMode(cwd, "full");
    expect(getViewMode(cwd)).toBe("full");
    expect(loadPersistedViewMode(cwd)).toBe("full");
  });
});
