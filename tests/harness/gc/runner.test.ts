import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isMechanical, runHarnessGc } from "../../../src/harness/gc/runner.js";
import { renderGcReport } from "../../../src/harness/gc/reporter.js";
import { appendOpen, readAll } from "../../../src/harness/anti_slop/queue.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { SlopBackend } from "../../../src/harness/anti_slop/backend.js";
import type { HarnessSlopQueueEntry } from "../../../src/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-gc-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(overrides: Partial<HarnessSlopQueueEntry>): HarnessSlopQueueEntry {
  return {
    id: "x",
    kind: "dead-code",
    file: "src/foo.ts",
    range: null,
    severity: "warning",
    source: "fallow",
    state: "open",
    message: "msg",
    ts: "2026-05-03T12:00:00.000Z",
    ...overrides,
  };
}

const FIX_OK_BACKEND: SlopBackend = {
  id: "fallow",
  async isAvailable() {
    return true;
  },
  async scan() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async dupes() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async deadCode() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async audit() {
    return { ok: true, findings: [], durationMs: 0 };
  },
  async fix(_p, opts) {
    return { ok: true, appliedIds: opts.entryIds ?? [], failedIds: [] };
  },
};

const FIX_FAIL_BACKEND: SlopBackend = {
  ...FIX_OK_BACKEND,
  async fix(_p, opts) {
    return {
      ok: false,
      appliedIds: [],
      failedIds: (opts.entryIds ?? []).map((id) => ({ id, reason: "stub failed" })),
    };
  },
};

describe("isMechanical", () => {
  test("dead-code → mechanical", () => {
    expect(isMechanical(entry({ kind: "dead-code" }))).toBe(true);
  });
  test("duplicate → judgmental", () => {
    expect(isMechanical(entry({ kind: "duplicate" }))).toBe(false);
  });
  test("layer-violation → judgmental", () => {
    expect(isMechanical(entry({ kind: "layer-violation" }))).toBe(false);
  });
});

describe("runHarnessGc", () => {
  test("classifies and resolves mechanical entries", async () => {
    appendOpen(paths, cwd, entry({ id: "dead-1", kind: "dead-code" }));
    appendOpen(paths, cwd, entry({ id: "dup-1", kind: "duplicate" }));
    const report = await runHarnessGc({
      platform: { paths } as any,
      paths,
      cwd,
      backend: "fallow",
      adapter: FIX_OK_BACKEND,
      apply: true,
    });
    expect(report.inspected).toBe(2);
    expect(report.judgmentalReported).toBe(1);
    expect(report.mechanicalAttempted).toBe(1);
    expect(report.mechanicalResolved).toBe(1);
    const queue = readAll(paths, cwd);
    if (queue.ok) {
      const dead = queue.value.find((e) => e.id === "dead-1");
      expect(dead?.state).toBe("resolved");
      const dup = queue.value.find((e) => e.id === "dup-1");
      expect(dup?.state).toBe("open");
    }
  });

  test("records failures when fix fails", async () => {
    appendOpen(paths, cwd, entry({ id: "dead-1", kind: "dead-code" }));
    const report = await runHarnessGc({
      platform: { paths } as any,
      paths,
      cwd,
      backend: "fallow",
      adapter: FIX_FAIL_BACKEND,
      apply: true,
    });
    expect(report.mechanicalResolved).toBe(0);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0].reason).toBe("stub failed");
  });

  test("supi-native (null adapter) skips mechanical", async () => {
    appendOpen(paths, cwd, entry({ id: "dead-1", kind: "dead-code" }));
    const report = await runHarnessGc({
      platform: { paths } as any,
      paths,
      cwd,
      backend: "supi-native",
      adapter: null,
      apply: true,
    });
    expect(report.mechanicalAttempted).toBe(0);
    expect(report.mechanicalResolved).toBe(0);
  });
});

describe("renderGcReport", () => {
  test("renders summary lines", () => {
    const out = renderGcReport({
      inspected: 5,
      mechanicalAttempted: 3,
      mechanicalResolved: 2,
      judgmentalReported: 2,
      failures: [{ id: "foo", reason: "boom" }],
      durationMs: 42,
    });
    expect(out).toContain("Inspected:");
    expect(out).toContain("foo: boom");
  });
});
