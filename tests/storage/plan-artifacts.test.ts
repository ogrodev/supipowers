import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readPlanFile, savePlan } from "../../src/storage/plans.js";
import { createHermeticPaths } from "../helpers/paths.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createHermeticPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-plan-artifacts-"));
  cwd = path.join(tmpDir, "repo");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "repo" }), "utf8");
  paths = createHermeticPaths(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("plan artifact storage", () => {
  test("savePlan writes LF-only markdown with a trailing newline", () => {
    const filePath = savePlan(paths, cwd, "draft.md", "# Plan\r\n\r\n- item");
    const raw = fs.readFileSync(filePath, "utf8");

    expect(raw).toBe("# Plan\n\n- item\n");
    expect(raw).not.toContain("\r");
    expect(readPlanFile(paths, cwd, "draft.md")).toBe(raw);
  });
});
