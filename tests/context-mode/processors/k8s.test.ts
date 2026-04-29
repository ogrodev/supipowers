import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { K8S_INVARIANT, k8sProcessor } from "../../../src/context-mode/processors/k8s.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, "fixtures", "k8s");
const encoder = new TextEncoder();

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

function process(text: string) {
  return k8sProcessor(text, { exitCode: 0, eol: text.includes("\r\n") ? "\r\n" : "\n" });
}

function expectUnderBudget(text: string): void {
  expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(K8S_INVARIANT.maxBytes);
}

describe("k8sProcessor", () => {
  test("get output preserves header, resource, status, and namespace columns", () => {
    const output = process(fixture("get-large-posix.txt"));
    expect(output.processorKey).toBe("k8s");
    expect(output.text).toContain("NAMESPACE   NAME");
    expect(output.text).toContain("default     worker-def");
    expect(output.text).toContain("CrashLoopBackOff");
    expect(output.text).toContain("kube-system coredns-xyz");
    expectUnderBudget(output.text);
  });

  test("describe output preserves Name, Status, and Events blocks", () => {
    const output = process(fixture("describe-large-posix.txt"));
    expect(output.text).toContain("Name:             api-abc");
    expect(output.text).toContain("Status:           Running");
    expect(output.text).toContain("Events:");
    expect(output.text).toContain("Warning  BackOff");
    expectUnderBudget(output.text);
  });

  test("logs output preserves last 20 lines", () => {
    const output = process(fixture("logs-large-posix.txt"));
    expect(output.text).toContain("line 06 request");
    expect(output.text).toContain("line 25 request");
    expect(output.text).not.toContain("line 05 request");
    expectUnderBudget(output.text);
  });

  test("preserves CRLF and determinism", () => {
    const input = fixture("get-large-crlf.txt");
    expect(process(input).text).toBe(process(input).text);
    expect(process(input).text).toContain("\r\n");
  });

  test("non-k8s text returns passthrough", () => {
    const input = "plain output";
    expect(k8sProcessor(input, { exitCode: 0, eol: "\n" })).toEqual({
      text: input,
      processorKey: "k8s",
      passthrough: true,
    });
  });
});
