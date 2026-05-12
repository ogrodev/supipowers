import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createPaths } from "../../../src/platform/types.js";
import { registerHarnessHooks } from "../../../src/harness/hooks/register.js";
import { getHarnessMarkerPath } from "../../../src/harness/project-paths.js";

let tmpDir: string;
let cwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-hooks-"));
  cwd = path.join(tmpDir, "repo");
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePlatform() {
  return {
    name: "omp",
    on: mock(),
    paths: createPaths(".omp"),
  } as any;
}

describe("registerHarnessHooks", () => {
  test("subscribes hooks even when the marker is missing — per-event guards gate runtime", () => {
    const platform = makePlatform();

    const registration = registerHarnessHooks(platform, { cwd, backend: "desloppify" });

    // Hooks subscribe at bootstrap so the marker can be written later (fresh install)
    // without requiring an OMP restart. Each handler re-checks the marker per event.
    expect(registration.active).toBe(true);
    expect(platform.on).toHaveBeenCalledTimes(3);
    expect(() => registration.dispose()).not.toThrow();
  });

  test("subscribes every anti-slop hook when the harness marker exists", () => {
    const platform = makePlatform();
    const markerPath = getHarnessMarkerPath(platform.paths, cwd);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ installedAt: "2026-05-11T00:00:00.000Z" }));

    const registration = registerHarnessHooks(platform, { cwd, backend: "desloppify" });

    expect(registration.active).toBe(true);
    expect(platform.on).toHaveBeenCalledTimes(3);
    expect(platform.on.mock.calls.map((call: unknown[]) => call[0]).sort()).toEqual([
      "agent_end",
      "before_agent_start",
      "tool_call",
    ]);
    expect(() => {
      registration.dispose();
      registration.dispose();
    }).not.toThrow();
  });
});
