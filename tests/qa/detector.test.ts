import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectFramework } from "../../src/qa/detector.js";

describe("detectFramework", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects vitest from config file", () => {
    fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}");
    const result = detectFramework(tmpDir);
    expect(result?.name).toBe("vitest");
  });

  test("detects from package.json test script", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    const result = detectFramework(tmpDir);
    expect(result?.name).toBe("vitest");
    expect(result?.command).toBe("npm test");
  });

  test("detects pytest", () => {
    fs.writeFileSync(path.join(tmpDir, "conftest.py"), "");
    const result = detectFramework(tmpDir);
    expect(result?.name).toBe("pytest");
  });

  test("returns null when nothing detected", () => {
    expect(detectFramework(tmpDir)).toBeNull();
  });
});
