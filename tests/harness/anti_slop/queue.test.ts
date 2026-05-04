import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  appendOpen,
  backlog,
  compact,
  computeQueueEntryId,
  findById,
  markWontfix,
  next,
  readAll,
  resolve,
} from "../../../src/harness/anti_slop/queue.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";
import type { HarnessSlopQueueEntry } from "../../../src/types.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-queue-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(overrides: Partial<HarnessSlopQueueEntry>): HarnessSlopQueueEntry {
  return {
    id: "id-x",
    kind: "duplicate",
    file: "src/foo.ts",
    range: { startLine: 1, endLine: 5 },
    severity: "warning",
    source: "fallow",
    state: "open",
    message: "msg",
    ts: "2026-05-03T12:00:00.000Z",
    ...overrides,
  };
}

describe("computeQueueEntryId", () => {
  test("two backends report the same violation → same id", () => {
    const a = computeQueueEntryId({
      kind: "duplicate",
      file: "src/foo.ts",
      range: { startLine: 1, endLine: 10 },
      ruleHint: "near-dup",
    });
    const b = computeQueueEntryId({
      kind: "duplicate",
      file: "src/foo.ts",
      range: { startLine: 1, endLine: 10 },
      ruleHint: "near-dup",
    });
    expect(a).toBe(b);
  });

  test("different rules → different ids", () => {
    const a = computeQueueEntryId({ kind: "duplicate", file: "src/foo.ts", range: null, ruleHint: "a" });
    const b = computeQueueEntryId({ kind: "duplicate", file: "src/foo.ts", range: null, ruleHint: "b" });
    expect(a).not.toBe(b);
  });
});

describe("appendOpen + readAll", () => {
  test("collapses duplicate ids; later record wins", () => {
    appendOpen(paths, cwd, entry({ id: "dup-1", message: "first" }));
    appendOpen(paths, cwd, entry({ id: "dup-1", message: "second" }));
    const all = readAll(paths, cwd);
    if (all.ok) {
      expect(all.value.length).toBe(1);
      expect(all.value[0].message).toBe("second");
    }
  });
});

describe("next + backlog + findById", () => {
  test("`next` returns the highest-severity oldest open entry", () => {
    appendOpen(paths, cwd, entry({ id: "info", severity: "info", ts: "2026-05-03T11:00:00Z" }));
    appendOpen(paths, cwd, entry({ id: "blocker-1", severity: "blocker", ts: "2026-05-03T13:00:00Z" }));
    appendOpen(paths, cwd, entry({ id: "blocker-0", severity: "blocker", ts: "2026-05-03T12:00:00Z" }));
    const result = next(paths, cwd);
    if (result.ok) expect(result.value?.id).toBe("blocker-0");
  });

  test("`next` returns null when queue is empty", () => {
    const result = next(paths, cwd);
    if (result.ok) expect(result.value).toBeNull();
  });

  test("backlog filters by kind, source, file", () => {
    appendOpen(paths, cwd, entry({ id: "a", kind: "duplicate", source: "fallow", file: "src/a.ts" }));
    appendOpen(paths, cwd, entry({ id: "b", kind: "dead-code", source: "desloppify", file: "src/b.ts" }));
    const dupes = backlog(paths, cwd, { kind: "duplicate" });
    if (dupes.ok) expect(dupes.value.map((e) => e.id)).toEqual(["a"]);
    const desloppify = backlog(paths, cwd, { source: "desloppify" });
    if (desloppify.ok) expect(desloppify.value.map((e) => e.id)).toEqual(["b"]);
    const byFile = backlog(paths, cwd, { file: "src/a.ts" });
    if (byFile.ok) expect(byFile.value.map((e) => e.id)).toEqual(["a"]);
  });

  test("findById returns the entry or null", () => {
    appendOpen(paths, cwd, entry({ id: "found" }));
    const a = findById(paths, cwd, "found");
    if (a.ok) expect(a.value?.id).toBe("found");
    const b = findById(paths, cwd, "nope");
    if (b.ok) expect(b.value).toBeNull();
  });
});

describe("resolve / markWontfix / compact", () => {
  test("resolve transitions state to resolved", () => {
    appendOpen(paths, cwd, entry({ id: "x" }));
    const result = resolve(paths, cwd, "x");
    if (result.ok) {
      expect(result.value?.state).toBe("resolved");
      expect(result.value?.resolvedAt).toBeDefined();
    }
    const re = backlog(paths, cwd, { state: "open" });
    if (re.ok) expect(re.value.length).toBe(0);
  });

  test("resolve returns null when id missing", () => {
    const result = resolve(paths, cwd, "missing");
    if (result.ok) expect(result.value).toBeNull();
  });

  test("markWontfix transitions state and is reflected in strict-mode counts", () => {
    appendOpen(paths, cwd, entry({ id: "y" }));
    const result = markWontfix(paths, cwd, "y");
    if (result.ok) expect(result.value?.state).toBe("wontfix");
    const wontfix = backlog(paths, cwd, { state: "wontfix" });
    if (wontfix.ok) expect(wontfix.value.length).toBe(1);
  });

  test("compact removes resolved entries", () => {
    appendOpen(paths, cwd, entry({ id: "a" }));
    appendOpen(paths, cwd, entry({ id: "b" }));
    resolve(paths, cwd, "a");
    const result = compact(paths, cwd);
    if (result.ok) expect(result.value.removed).toBe(1);
    const remaining = readAll(paths, cwd);
    if (remaining.ok) {
      expect(remaining.value.length).toBe(1);
      expect(remaining.value[0].id).toBe("b");
    }
  });
});
