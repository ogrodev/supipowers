// tests/context-mode/snapshot-builder.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventStore } from "../../src/context-mode/event-store.js";
import { buildResumeSnapshot } from "../../src/context-mode/snapshot-builder.js";

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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvent(category: string, data: Record<string, unknown>, priority = "medium") {
  store.writeEvent({
    sessionId: SESSION,
    category: category as any,
    data: JSON.stringify(data),
    priority: priority as any,
    source: "test",
    timestamp: Date.now(),
  });
}

describe("buildResumeSnapshot", () => {
  test("returns empty string for empty event store", () => {
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toBe("");
  });

  test("includes last_request from most recent prompt", () => {
    writeEvent("prompt", { prompt: "fix the bug in parser.ts" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<last_request>");
    expect(snapshot).toContain("fix the bug in parser.ts");
  });

  test("includes pending_tasks from task events", () => {
    writeEvent("task", { input: { ops: [{ op: "add_task", content: "Refactor utils" }] } }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<pending_tasks>");
    expect(snapshot).toContain("Refactor utils");
  });

  test("includes files_modified from file write/edit events", () => {
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, "high");
    writeEvent("file", { op: "write", path: "/src/new.ts" }, "high");
    writeEvent("file", { op: "read", path: "/src/old.ts" }); // reads excluded
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<files_modified>");
    expect(snapshot).toContain("/src/types.ts");
    expect(snapshot).toContain("/src/new.ts");
    expect(snapshot).not.toContain("/src/old.ts");
  });

  test("includes recent_errors", () => {
    writeEvent("error", { command: "npm test", exitCode: 1, output: "FAIL" }, "critical");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<recent_errors>");
    expect(snapshot).toContain("npm test");
  });

  test("includes git_state", () => {
    writeEvent("git", { command: "git commit -m 'fix'", output: "1 file changed" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<git_state>");
    expect(snapshot).toContain("git commit");
  });

  test("omits sections with no events", () => {
    writeEvent("prompt", { prompt: "hello" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(snapshot).toContain("<last_request>");
    expect(snapshot).not.toContain("<pending_tasks>");
    expect(snapshot).not.toContain("<files_modified>");
    expect(snapshot).not.toContain("<recent_errors>");
    expect(snapshot).not.toContain("<git_state>");
  });

  test("output is under 2KB for large event sets", () => {
    for (let i = 0; i < 100; i++) {
      writeEvent("file", { op: "edit", path: `/src/file${i}.ts` }, "high");
      writeEvent("error", { command: `cmd${i}`, output: "x".repeat(100) }, "critical");
    }
    const snapshot = buildResumeSnapshot(store, SESSION);
    expect(new TextEncoder().encode(snapshot).byteLength).toBeLessThan(2048);
  });

  test("deduplicates file paths", () => {
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, "high");
    writeEvent("file", { op: "edit", path: "/src/types.ts" }, "high");
    const snapshot = buildResumeSnapshot(store, SESSION);
    const matches = snapshot.match(/\/src\/types\.ts/g);
    expect(matches).toHaveLength(1);
  });
});
