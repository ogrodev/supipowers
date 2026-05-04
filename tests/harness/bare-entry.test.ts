import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  describeMarker,
  isHarnessInstalled,
  loadMarker,
  resolveBareEntry,
  writeMarker,
} from "../../src/harness/bare-entry.js";
import { createTestPaths, createTestRepo } from "../ultraplan/fixtures.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-bare-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadMarker / writeMarker", () => {
  test("loadMarker returns null when missing", () => {
    expect(loadMarker(paths, cwd)).toBeNull();
    expect(isHarnessInstalled(paths, cwd)).toBe(false);
  });

  test("writeMarker + loadMarker round-trip", () => {
    const result = writeMarker(paths, cwd, {
      installedAt: "2026-05-03T12:00:00.000Z",
      backend: "fallow",
    });
    expect(result.ok).toBe(true);
    const loaded = loadMarker(paths, cwd);
    expect(loaded?.backend).toBe("fallow");
    expect(isHarnessInstalled(paths, cwd)).toBe(true);
  });

  test("describeMarker handles null", () => {
    expect(describeMarker(null)).toContain("not installed");
    expect(describeMarker({ installedAt: "2026-05-03T12:00:00.000Z", backend: "fallow" })).toContain("fallow");
  });
});

describe("resolveBareEntry", () => {
  test("fresh-install when no marker", async () => {
    const decision = await resolveBareEntry({
      paths,
      cwd,
      prompt: async () => "harden",
    });
    expect(decision.kind).toBe("fresh-install");
  });

  test("rerun + harden when marker present and user picks harden", async () => {
    writeMarker(paths, cwd, { installedAt: "2026-05-03T12:00:00.000Z", backend: "fallow" });
    const decision = await resolveBareEntry({
      paths,
      cwd,
      prompt: async () => "harden",
    });
    expect(decision.kind).toBe("rerun");
    if (decision.kind === "rerun") expect(decision.mode).toBe("harden");
  });

  test("rerun + cancel when prompt returns null", async () => {
    writeMarker(paths, cwd, { installedAt: "2026-05-03T12:00:00.000Z", backend: "fallow" });
    const decision = await resolveBareEntry({
      paths,
      cwd,
      prompt: async () => null,
    });
    expect(decision.kind).toBe("rerun");
    if (decision.kind === "rerun") expect(decision.mode).toBe("cancel");
  });

  test("rerun + rebuild path", async () => {
    writeMarker(paths, cwd, { installedAt: "2026-05-03T12:00:00.000Z", backend: "fallow" });
    const decision = await resolveBareEntry({
      paths,
      cwd,
      prompt: async () => "rebuild",
    });
    expect(decision.kind).toBe("rerun");
    if (decision.kind === "rerun") expect(decision.mode).toBe("rebuild");
  });
});
