
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateVisualSessionId,
  createSessionDir,
  writeScreen,
  readEvents,
  clearEvents,
  getScriptsDir,
} from "../../src/visual/companion.js";
import { createPaths } from "../../src/platform/types.js";

describe("visual companion", () => {
  let tmpDir: string;
  const paths = createPaths(".test");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-visual-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("generateVisualSessionId returns expected format", () => {
    const id = generateVisualSessionId();
    expect(id).toMatch(/^visual-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  test("generateVisualSessionId produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateVisualSessionId()));
    expect(ids.size).toBe(10);
  });

  test("createSessionDir creates the directory structure", () => {
    const sessionId = "visual-20260311-120000-test";
    const sessionDir = createSessionDir(paths, tmpDir, sessionId);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(sessionDir).toContain(path.join(".test", "supipowers", "visual", sessionId));
  });

  test("writeScreen writes HTML file to session dir", () => {
    const sessionDir = createSessionDir(paths, tmpDir, "visual-test");
    writeScreen(sessionDir, "screen-001.html", "<h1>Hello</h1>");
    const filePath = path.join(sessionDir, "screen-001.html");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("<h1>Hello</h1>");
  });

  test("readEvents returns empty array when no events file", () => {
    const sessionDir = createSessionDir(paths, tmpDir, "visual-test");
    expect(readEvents(sessionDir)).toEqual([]);
  });

  test("readEvents parses newline-delimited JSON", () => {
    const sessionDir = createSessionDir(paths, tmpDir, "visual-test");
    const eventsFile = path.join(sessionDir, ".events");
    fs.writeFileSync(eventsFile, [
      JSON.stringify({ type: "click", choice: "a", text: "Option A", timestamp: 1000 }),
      JSON.stringify({ type: "click", choice: "b", text: "Option B", timestamp: 2000 }),
    ].join("\n") + "\n");

    const events = readEvents(sessionDir);
    expect(events).toHaveLength(2);
    expect(events[0].choice).toBe("a");
    expect(events[1].choice).toBe("b");
  });

  test("readEvents skips invalid JSON lines", () => {
    const sessionDir = createSessionDir(paths, tmpDir, "visual-test");
    const eventsFile = path.join(sessionDir, ".events");
    fs.writeFileSync(eventsFile, [
      JSON.stringify({ type: "click", choice: "a", timestamp: 1000 }),
      "not json",
      JSON.stringify({ type: "click", choice: "c", timestamp: 3000 }),
    ].join("\n") + "\n");

    const events = readEvents(sessionDir);
    expect(events).toHaveLength(2);
  });

  test("clearEvents removes the events file", () => {
    const sessionDir = createSessionDir(paths, tmpDir, "visual-test");
    const eventsFile = path.join(sessionDir, ".events");
    fs.writeFileSync(eventsFile, '{"type":"click"}\n');
    expect(fs.existsSync(eventsFile)).toBe(true);

    clearEvents(sessionDir);
    expect(fs.existsSync(eventsFile)).toBe(false);
  });

  test("clearEvents is idempotent when no events file", () => {
    const sessionDir = createSessionDir(paths, tmpDir, "visual-test");
    expect(() => clearEvents(sessionDir)).not.toThrow();
  });

  test("getScriptsDir returns path to scripts directory", () => {
    const scriptsDir = getScriptsDir();
    expect(scriptsDir).toContain(path.join("visual", "scripts"));
  });
});
