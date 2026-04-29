import { describe, expect, test } from "bun:test";
import { runEmissionPipeline } from "../../src/context-mode/compressor.js";

const THRESHOLD = 100;

function toolResult(
  toolName: string,
  text: string,
  input: Record<string, unknown> = {},
  details: unknown = undefined,
) {
  return {
    type: "tool_result",
    toolName,
    toolCallId: "test-id",
    input,
    content: [{ type: "text", text }],
    isError: false,
    details,
  } as any;
}

describe("runEmissionPipeline", () => {
  test("large legacy read, grep, and find results report matching processor keys", () => {
    const readText = Array.from({ length: 120 }, (_, i) => `${i + 1}aa|line ${i}`).join("\n");
    const grepText = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts:${i}: match`).join("\n");
    const findText = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`).join("\n");

    expect(runEmissionPipeline(toolResult("read", readText, { path: "src/file.ts" }), THRESHOLD).processorKey).toBe("read");
    expect(runEmissionPipeline(toolResult("grep", grepText, { pattern: "match", path: "src" }), THRESHOLD).processorKey).toBe("grep");
    expect(runEmissionPipeline(toolResult("find", findText, { pattern: "src/**/*.ts" }), THRESHOLD).processorKey).toBe("find");
  });

  test("small and scoped results report passthrough", () => {
    expect(runEmissionPipeline(toolResult("read", "small", { path: "src/file.ts" }), THRESHOLD)).toEqual({
      result: undefined,
      processorKey: "passthrough",
    });

    const scopedRead = Array.from({ length: 120 }, (_, i) => `${i + 1}aa|line ${i}`).join("\n");
    expect(
      runEmissionPipeline(toolResult("read", scopedRead, { path: "src/file.ts", offset: 10 }), THRESHOLD),
    ).toEqual({ result: undefined, processorKey: "passthrough" });
  });

  test("unknown tools report null processor key", () => {
    const text = "x".repeat(THRESHOLD + 1);
    expect(runEmissionPipeline(toolResult("unknown", text), THRESHOLD)).toEqual({
      result: undefined,
      processorKey: null,
    });
  });

  test("OMP-minimized bash footer reports omp-minimizer", () => {
    const text = `${"x".repeat(THRESHOLD + 1)}\n[raw output: artifact://abc]`;
    expect(runEmissionPipeline(toolResult("bash", text, { command: "ls" }, { exitCode: 0 }), THRESHOLD)).toEqual({
      result: undefined,
      processorKey: "omp-minimizer",
    });
  });

  test("falls back to legacy bash compression when a matched processor passes through", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = runEmissionPipeline(
      toolResult("bash", text, { command: "bun test tests/example.test.ts" }, { exitCode: 0 }),
      THRESHOLD,
    );

    expect(result.processorKey).toBe("bash");
    expect(result.result?.content?.[0]?.text).toContain("[...compressed:");
  });

  test("known tool error and non-text results report passthrough", () => {
    const text = "x".repeat(THRESHOLD + 1);
    expect(
      runEmissionPipeline({ ...toolResult("bash", text, { command: "echo fail" }), isError: true }, THRESHOLD),
    ).toEqual({ result: undefined, processorKey: "passthrough" });

    expect(
      runEmissionPipeline(
        {
          ...toolResult("bash", text, { command: "echo image" }),
          content: [
            { type: "text", text },
            { type: "image", source: { type: "base64", data: "...", media_type: "image/png" } },
          ],
        } as any,
        THRESHOLD,
      ),
    ).toEqual({ result: undefined, processorKey: "passthrough" });
  });
});


describe("runEmissionPipeline registry JSON overrides", () => {
  test("reports json for k8s and docker JSON output", () => {
    const k8sJson = JSON.stringify({
      items: Array.from({ length: 20 }, (_, i) => ({ name: `pod-${i}`, status: "Running" })),
    });
    const dockerJson = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ Id: `abc${i}`, Name: `container-${i}` })),
    );

    expect(
      runEmissionPipeline(
        toolResult("bash", k8sJson, { command: "kubectl get pods -o json" }, { exitCode: 0 }),
        THRESHOLD,
      ).processorKey,
    ).toBe("json");
    expect(
      runEmissionPipeline(
        toolResult("bash", dockerJson, { command: "docker inspect abc" }, { exitCode: 0 }),
        THRESHOLD,
      ).processorKey,
    ).toBe("json");
  });
});