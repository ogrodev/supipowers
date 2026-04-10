import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stopVisualServer } from "../../src/visual/stop-server";

describe("stopVisualServer", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("no PID file — returns not_running", () => {
    const result = stopVisualServer(tmpDir);
    expect(result).toEqual({ status: "not_running" });
  });

  test("session dir doesn't exist — returns not_running", () => {
    const nonexistent = path.join(tmpDir, "nope", "missing");
    const result = stopVisualServer(nonexistent);
    expect(result).toEqual({ status: "not_running" });
  });

  test("corrupt PID file — returns not_running and cleans up", () => {
    const pidFile = path.join(tmpDir, ".server.pid");
    fs.writeFileSync(pidFile, "abc\n");

    const result = stopVisualServer(tmpDir);
    expect(result).toEqual({ status: "not_running" });
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  test("valid PID of dead process — returns stopped, removes pid, log, and server info", () => {
    const pidFile = path.join(tmpDir, ".server.pid");
    const logFile = path.join(tmpDir, ".server.log");
    const infoFile = path.join(tmpDir, ".server-info");
    fs.writeFileSync(pidFile, "99999999\n");
    fs.writeFileSync(logFile, "some log content\n");
    fs.writeFileSync(infoFile, '{"type":"server-started"}\n');

    const result = stopVisualServer(tmpDir);
    expect(result).toEqual({ status: "stopped" });
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(infoFile)).toBe(false);
  });

  test("cleanup removes pid, log, and server info files", () => {
    const pidFile = path.join(tmpDir, ".server.pid");
    const logFile = path.join(tmpDir, ".server.log");
    const infoFile = path.join(tmpDir, ".server-info");
    fs.writeFileSync(pidFile, "99999999\n");
    fs.writeFileSync(logFile, "server output\n");
    fs.writeFileSync(infoFile, '{"type":"server-started"}\n');

    stopVisualServer(tmpDir);

    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.existsSync(infoFile)).toBe(false);
  });

  test("only PID file exists, no log — no error from missing log", () => {
    const pidFile = path.join(tmpDir, ".server.pid");
    fs.writeFileSync(pidFile, "99999999\n");

    const logFile = path.join(tmpDir, ".server.log");
    expect(fs.existsSync(logFile)).toBe(false);

    const result = stopVisualServer(tmpDir);
    expect(result).toEqual({ status: "stopped" });
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
