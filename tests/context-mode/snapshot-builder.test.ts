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

function writeEvent(category: string, data: Record<string, unknown>, priority: number = 3) {
  store.writeEvent({
    sessionId: SESSION,
    category: category as any,
    data: JSON.stringify(data),
    priority: priority as any,
    source: "test",
    timestamp: Date.now(),
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
    writeEvent("task", { input: { ops: [{ op: "add_task", content: "Refactor utils" }] } }, 2);
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
    writeEvent("task", { input: { ops: [{ op: "add_task", content: "Do stuff" }] } }, 2);
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
  });

  test("cwd section from cwd events", () => {
    writeEvent("cwd", { cwd: "/Users/dev/project" }, 4);
    const snapshot = buildResumeSnapshot(store, SESSION, refOpts);
    expect(snapshot).toContain("<cwd>/Users/dev/project</cwd>");
  });
});
