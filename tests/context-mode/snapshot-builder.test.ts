// tests/context-mode/snapshot-builder.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore } from "../../src/context-mode/event-store.js";
import { buildResumeSnapshot } from "../../src/context-mode/snapshot-builder.js";
import { rmDirWithRetry } from "../helpers/fs.js";

let tmpDir: string;
let store: EventStore;
const SESSION = "test-session";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-snapshot-"));
  store = new EventStore(path.join(tmpDir, "events.db"));
  store.init();
});

afterEach(() => {
  store.close();
  rmDirWithRetry(tmpDir);
});

function writeEvent(
  category: string,
  data: Record<string, unknown>,
  priority: number = 3,
  timestamp = Date.now(),
) {
  store.writeEvent({
    sessionId: SESSION,
    category: category as any,
    data: JSON.stringify(data),
    priority: priority as any,
    source: "test",
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// Fallback mode (existing behavior — no opts or searchAvailable=false)
// ---------------------------------------------------------------------------

describe("buildResumeSnapshot — fallback mode", () => {
  test("returns empty string for empty event store", () => {
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toBe("");
  });

  test("includes last_request from most recent prompt", () => {
    writeEvent("prompt", { prompt: "fix the bug in parser.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<last_request>");
    expect(snapshot).toContain("fix the bug in parser.ts");
  });

  test("includes pending_tasks from task events", () => {
    writeEvent("task", { input: { ops: [{ op: "init", list: [{ phase: "Implementation", items: ["Refactor utils"] }] }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<pending_tasks>");
    expect(snapshot).toContain("Refactor utils");
  });

  test("includes files_modified from file write/edit events", () => {
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, 2);
    writeEvent("file", { op: "write", path: "/src/new.ts" }, 2);
    writeEvent("file", { op: "read", path: "/src/old.ts" }); // reads excluded
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<files_modified>");
    expect(snapshot).toContain("/src/types.ts");
    expect(snapshot).toContain("/src/new.ts");
    expect(snapshot).not.toContain("/src/old.ts");
  });

  test("includes recent_errors", () => {
    writeEvent("error", { command: "npm test", exitCode: 1, output: "FAIL" }, 1);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<recent_errors>");
    expect(snapshot).toContain("npm test");
  });

  test("includes git_state", () => {
    writeEvent("git", { command: "git commit -m 'fix'", output: "1 file changed" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<git_state>");
    expect(snapshot).toContain("git commit");
  });

  test("omits sections with no events", () => {
    writeEvent("prompt", { prompt: "hello" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<last_request>");
    expect(snapshot).not.toContain("<pending_tasks>");
    expect(snapshot).not.toContain("<files_modified>");
    expect(snapshot).not.toContain("<recent_errors>");
    expect(snapshot).not.toContain("<git_state>");
  });

  test("output is under 2KB for large event sets", () => {
    for (let i = 0; i < 100; i++) {
      writeEvent("file", { op: "edit", path: `/src/file${i}.ts` }, 2);
      writeEvent("error", { command: `cmd${i}`, output: "x".repeat(100) }, 1);
    }
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThan(2048);
  }, process.platform === "win32" ? 20_000 : undefined);

  test("deduplicates file paths", () => {
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, 2);
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    const matches = snapshot.match(/\/src\/types\.ts/g);
    expect(matches).toHaveLength(1);
  });

  test("omitting opts produces old format without how_to_search", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).not.toContain("<how_to_search>");
    expect(snapshot).toContain("<files_modified>");
  });

  test("searchAvailable=false produces old format", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, { searchAvailable: false });
    expect(snapshot).not.toContain("<how_to_search>");
    expect(snapshot).toContain("<files_modified>");
  });

  test("fallback masks stale same-source modified file observations", () => {
    writeEvent("file", { op: "edit", path: "C:\\repo\\src\\old.ts", sourceHash: "same-source" }, 2, 1);
    writeEvent("file", { op: "edit", path: "C:\\repo\\src\\new.ts", sourceHash: "same-source" }, 2, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("C:\\repo\\src\\new.ts");
    expect(snapshot).not.toContain("C:\\repo\\src\\old.ts");
    expect(snapshot).toContain("stale observations masked: 1");
  });

  test("fallback masks same-timestamp stale modified observations by insertion order", () => {
    writeEvent("file", { op: "edit", path: "/src/old.ts", sourceHash: "same-source" }, 2, 1);
    writeEvent("file", { op: "edit", path: "/src/new.ts", sourceHash: "same-source" }, 2, 1);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("/src/new.ts");
    expect(snapshot).not.toContain("/src/old.ts");
    expect(snapshot).toContain("stale observations masked: 1");
  });

  test("fallback: newer read does not mask older edit on the same source (F3)", () => {
    // Edit at t=1, read at t=2 with the same path (no sourceHash → fallback to path).
    writeEvent("file", { op: "edit", path: "/src/foo.ts" }, 2, 1);
    writeEvent("file", { op: "read", path: "/src/foo.ts" }, 2, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<files_modified>");
    expect(snapshot).toContain("/src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// Reference-based format (searchAvailable=true)
// ---------------------------------------------------------------------------

describe("buildResumeSnapshot — reference format", () => {
  const refOpts = { searchAvailable: true, searchTool: "ctx_search" };

  test("returns empty string for empty event store", () => {
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toBe("");
  });

  test("includes how_to_search and ctx_search tool calls", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<how_to_search>");
    expect(snapshot).toContain("ctx_search(queries:");
  });

  test("includes compact_count attribute", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, { ...refOpts, compactCount: 42 });
    expect(snapshot).toContain('compact_count="42"');
  }, process.platform === "win32" ? 20_000 : undefined);

  test("includes generated_at attribute with ISO date", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    // ISO dates look like 2026-04-09T...
    expect(snapshot).toMatch(/generated_at="[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  test("escapeXML on interpolated user data", () => {
    writeEvent("file", { op: "edit", path: "<script>alert('xss')</script>" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("&lt;script&gt;alert(&apos;xss&apos;)&lt;/script&gt;");
    expect(snapshot).not.toContain("<script>");
  });

  test("section ordering: rules before files before tasks", () => {
    writeEvent("rule", { file: ".pi/rules.md" }, 3);
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    writeEvent("task", { input: { ops: [{ op: "init", list: [{ phase: "Implementation", items: ["Do stuff"] }] }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);

    const rulesIdx = snapshot.indexOf("<rules>");
    const filesIdx = snapshot.indexOf("<files");
    const tasksIdx = snapshot.indexOf("<tasks>");
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(-1);
    expect(tasksIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(filesIdx);
    expect(filesIdx).toBeLessThan(tasksIdx);
  });

  test("reference snapshot keeps latest observation and reports stale masked count", () => {
    writeEvent("file", { op: "read", path: "/src/old.ts", sourceHash: "same-source" }, 3, 1);
    writeEvent("file", { op: "read", path: "/src/new.ts", sourceHash: "same-source" }, 3, 2);
    writeEvent("file", { op: "read", path: "/src/other.ts", sourceHash: "other-source" }, 3, 3);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain('stale_masked="1"');
    expect(snapshot).toContain("Masked stale observations: 1");
    expect(snapshot).toContain("/src/new.ts");
    expect(snapshot).toContain("/src/other.ts");
    expect(snapshot).not.toContain("/src/old.ts");
  });

  test("reference snapshot masks same-timestamp stale observations by insertion order", () => {
    writeEvent("file", { op: "read", path: "/src/old.ts", sourceHash: "same-source" }, 3, 1);
    writeEvent("file", { op: "read", path: "/src/new.ts", sourceHash: "same-source" }, 3, 1);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain('stale_masked="1"');
    expect(snapshot).toContain("/src/new.ts");
    expect(snapshot).not.toContain("/src/old.ts");
  });

  test("reference: newer read does not mask older edit on the same path (F3)", () => {
    writeEvent("file", { op: "edit", path: "/src/foo.ts" }, 2, 1);
    writeEvent("file", { op: "read", path: "/src/foo.ts" }, 2, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("Edited: /src/foo.ts");
    // The path appears as Edited; it must not also appear under Read because
    // modifications dominate the same path.
    expect(snapshot).not.toContain("Read: /src/foo.ts");
  });

  test("reference masks older reads after newer edit on the same canonical source", () => {
    writeEvent("file", { op: "read", path: "/repo/src/foo.ts", sourceHash: "same-source" }, 3, 1);
    writeEvent("file", { op: "edit", path: "src/foo.ts", sourceHash: "same-source" }, 2, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("Edited: src/foo.ts");
    expect(snapshot).not.toContain("Read: /repo/src/foo.ts");
    expect(snapshot).toContain('stale_masked="1"');
  });

  test("empty sections omitted", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<files");
    expect(snapshot).not.toContain("<rules>");
    expect(snapshot).not.toContain("<skills>");
    expect(snapshot).not.toContain("<intent>");
    expect(snapshot).not.toContain("<env>");
    expect(snapshot).not.toContain("<decisions>");
    expect(snapshot).not.toContain("<errors>");
    expect(snapshot).not.toContain("<git>");
  });

  test("rules section from rule events", () => {
    writeEvent("rule", { file: ".pi/rules.md" }, 3);
    writeEvent("rule", { file: ".pi/code-style.md" }, 3);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<rules>");
    expect(snapshot).toContain("Loaded 2 project rule files");
    expect(snapshot).toContain(".pi/rules.md");
    expect(snapshot).toContain(".pi/code-style.md");
  });

  test("skills section from skill events", () => {
    writeEvent("skill", { name: "tdd" }, 3);
    writeEvent("skill", { name: "debugging" }, 3);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<skills>");
    expect(snapshot).toContain("Activated:");
    expect(snapshot).toContain("tdd");
    expect(snapshot).toContain("debugging");
  });

  test("intent section from intent events", () => {
    writeEvent("intent", { mode: "planning" }, 3);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<intent>Session mode: planning</intent>");
  });

  test("env section from env events", () => {
    writeEvent("env", { detail: "node v20.11.0" }, 4);
    writeEvent("env", { detail: "bun 1.1.0" }, 4);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<env>");
    expect(snapshot).toContain("node v20.11.0");
    expect(snapshot).toContain("bun 1.1.0");
  });

  test("files section separates edited and read paths", () => {
    writeEvent("file", { op: "edit", path: "/src/a.ts" }, 2);
    writeEvent("file", { op: "read", path: "/src/b.ts" }, 4);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("Edited: /src/a.ts");
    expect(snapshot).toContain("Read: /src/b.ts");
    expect(snapshot).toContain('count="2"');
  });

  test("decisions section from decision events", () => {
    writeEvent("decision", { prompt: "Use Bun over Node" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<decisions>");
    expect(snapshot).toContain("Use Bun over Node");
  });

  test("errors section from error events", () => {
    writeEvent("error", { command: "bun test", exitCode: 1 }, 1);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<errors>");
    expect(snapshot).toContain("bun test");
  });

  test("git section from git events", () => {
    writeEvent("git", { command: "git push origin main" }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<git>");
    expect(snapshot).toContain("git push origin main");
  }, process.platform === "win32" ? 20_000 : undefined);

  test("cwd section from cwd events", () => {
    writeEvent("cwd", { cwd: "/Users/dev/project" }, 4);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<cwd>/Users/dev/project</cwd>");
  });
});


// ---------------------------------------------------------------------------
// extractTaskContent projection (OMP 14.5.11+ todo_write shape)
// Exercised through buildResumeSnapshot's <pending_tasks> section.
// ---------------------------------------------------------------------------

describe("todo_write payload projection", () => {
  function pendingTasksContent(snapshot: string): string {
    const open = snapshot.indexOf("<pending_tasks>");
    const close = snapshot.indexOf("</pending_tasks>");
    if (open < 0 || close < 0) return "";
    return snapshot.slice(open, close);
  }

  test("init with multiple phases joins all task contents", () => {
    writeEvent("task", {
      input: {
        ops: [
          {
            op: "init",
            list: [
              { phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
              { phase: "Auth", items: ["Port store"] },
            ],
          },
        ],
      },
    }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    const block = pendingTasksContent(snapshot);
    expect(block).toContain("init: Scaffold crate");
    // 100-char cap may truncate later entries; first entry must always survive.
    expect(block).toContain("init:");
  });

  test("append projects string items", () => {
    writeEvent("task", {
      input: { ops: [{ op: "append", phase: "Auth", items: ["Handle retries"] }] },
    }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("append: Handle retries");
  });

  test("note projects text", () => {
    writeEvent("task", {
      input: { ops: [{ op: "note", task: "Wait for review", text: "Wait for review" }] },
    }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("note: Wait for review");
  });

  test("start with task content renders 'verb: target'", () => {
    writeEvent("task", { input: { ops: [{ op: "start", task: "Refactor utils" }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("start: Refactor utils");
  });

  test("done with phase id renders 'verb: phase'", () => {
    writeEvent("task", { input: { ops: [{ op: "done", phase: "Auth" }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("done: Auth");
  });

  test("drop without task or phase renders 'verb: all'", () => {
    writeEvent("task", { input: { ops: [{ op: "drop" }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("drop: all");
  });

  test("rm without task or phase renders 'verb: all'", () => {
    writeEvent("task", { input: { ops: [{ op: "rm" }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("rm: all");
  });

  test("legacy ops with content preserve stored task text", () => {
    writeEvent("task", { input: { ops: [{ op: "add_task", content: "Refactor utils" }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("add_task: Refactor utils");
    expect(snapshot).not.toContain("add_task: all");
  });

  test("input.ops missing falls back to JSON.stringify(input).slice(0, 100)", () => {
    writeEvent("task", { input: { add_tasks: [{ phase: "Implementation", content: "Fix bug" }] } }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    const block = pendingTasksContent(snapshot);
    expect(block).toContain("add_tasks");
    expect(block).toContain("Fix bug");
  });

  test("all-empty init with no items returns null and omits the task entry", () => {
    writeEvent("task", {
      input: { ops: [{ op: "init", list: [{ phase: "Foundation", items: [""] }] }] },
    }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    // <pending_tasks> opens because there is a task event, but the projected content is empty.
    const block = pendingTasksContent(snapshot);
    expect(block).not.toContain("init:");
    expect(block).not.toContain("task:");
  });

  test("legacy replace/phases shape preserves task content for back-compat", () => {
    // Persisted event rows from before the 14.5.11 reshape still carry the old
    // shape until the 7-day retention expires; resume snapshots must remain truthful.
    writeEvent("task", {
      input: {
        ops: [
          {
            op: "replace",
            phases: [
              { name: "I. Foo", tasks: [{ content: "Refactor utils" }, { content: "Add tests" }] },
              { name: "II. Bar", tasks: [{ content: "Wire route" }] },
            ],
          },
        ],
      },
    }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    const block = pendingTasksContent(snapshot);
    expect(block).toContain("replace: Refactor utils");
    // The 100-char cap may truncate later entries; first entry must always survive.
    expect(block).not.toContain("replace: all");
  });

  test("legacy append items shaped as objects with `label` are projected", () => {
    writeEvent("task", {
      input: { ops: [{ op: "append", phase: "Auth", items: [{ label: "Handle retries" }] }] },
    }, 2);
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("append: Handle retries");
  });
});