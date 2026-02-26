import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCommandLines, parseQaArgs } from "../../src/qa/input";

describe("qa input parsing", () => {
  test("parses inline workflow and url flag", () => {
    const parsed = parseQaArgs("Checkout flow --url http://localhost:3000", process.cwd());

    expect(parsed.workflow).toBe("Checkout flow");
    expect(parsed.targetUrl).toBe("http://localhost:3000");
    expect(parsed.workflowSource).toBe("inline");
  });

  test("loads workflow from @file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "supipowers-qa-input-"));
    const workflowPath = join(cwd, "workflow.md");
    writeFileSync(workflowPath, "Test login + checkout flow\n", "utf-8");

    const parsed = parseQaArgs("@workflow.md", cwd);
    expect(parsed.workflowSource).toBe("file");
    expect(parsed.workflow).toContain("login + checkout");
    expect(parsed.workflowFilePath).toBe(workflowPath);
  });

  test("parses command lines from semicolon/newline", () => {
    const lines = parseCommandLines("goto http://localhost; click e1\nfill e2 hello");
    expect(lines).toEqual(["goto http://localhost", "click e1", "fill e2 hello"]);
  });
});
