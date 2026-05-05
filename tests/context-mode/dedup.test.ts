import { describe, expect, test } from "bun:test";
import {
  combinedTextOf,
  createDedupState,
  maybeSubstitute,
  TTL_TURNS,
} from "../../src/context-mode/dedup.js";

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("context-mode dedup", () => {
  test("combinedTextOf joins text content entries", () => {
    expect(combinedTextOf([
      { type: "text", text: "first" },
      { type: "image", text: "ignored" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
  });

  test("first emission stores content hash and metadata", () => {
    const dedupState = createDedupState();
    const result = textResult("stable payload");

    const substituted = maybeSubstitute({
      result,
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 14,
    });

    expect(substituted).toEqual({ result, processorKey: "git" });
    expect(dedupState.turnCounter).toBe(1);

    const record = dedupState.records.get("source-1");
    expect(record).toBeDefined();
    expect(record?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.turnId).toBe(1);
    expect(record?.bytes).toBe(14);
    expect(record?.tsMonotonic).toBe(1);
  });

  test("immediate identical re-emission returns dedup placeholder without advancing turn", () => {
    const dedupState = createDedupState();

    maybeSubstitute({
      result: textResult("stable payload"),
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 14,
    });

    const substituted = maybeSubstitute({
      result: textResult("stable payload"),
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 14,
    });

    expect(substituted.processorKey).toBe("dedup");
    expect(substituted.result?.content?.[0]?.text).toContain("same as turn 1");
    expect(substituted.result?.content?.[0]?.text).toContain("14 B");
    expect(substituted.result?.content?.[0]?.text).toContain("processor=git");
    expect(dedupState.turnCounter).toBe(1);
    expect(dedupState.records.get("source-1")?.turnId).toBe(1);
  });

  test("changed content refreshes the state instead of returning a placeholder", () => {
    const dedupState = createDedupState();
    maybeSubstitute({
      result: textResult("old payload"),
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 11,
    });

    const freshResult = textResult("changed payload");
    const substituted = maybeSubstitute({
      result: freshResult,
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 15,
    });

    expect(substituted.processorKey).toBe("git");
    const text = substituted.result?.content?.[0]?.text ?? "";
    expect(text).toContain("supersedes turn 1");
    expect(text).toContain("was 11 B");
    expect(text).toContain("old bytes remain in transcript history");
    expect(text).toContain("changed payload");
    expect(dedupState.turnCounter).toBe(2);
    expect(dedupState.records.get("source-1")?.turnId).toBe(2);
    expect(dedupState.records.get("source-1")?.bytes).toBe(15);
  });

  test("identical content after TTL expiry refreshes the state", () => {
    const dedupState = createDedupState();
    maybeSubstitute({
      result: textResult("stable payload"),
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 14,
    });

    for (let i = 0; i < TTL_TURNS; i += 1) {
      maybeSubstitute({
        result: textResult(`other payload ${i}`),
        processorKey: "git",
        sourceHash: `source-other-${i}`,
        dedupState,
        processedBytes: 15 + i,
      });
    }

    const freshResult = textResult("stable payload");
    const substituted = maybeSubstitute({
      result: freshResult,
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 1234,
    });

    expect(substituted).toEqual({ result: freshResult, processorKey: "git" });
    expect(dedupState.turnCounter).toBe(TTL_TURNS + 2);
    expect(dedupState.records.get("source-1")?.turnId).toBe(TTL_TURNS + 2);
    expect(dedupState.records.get("source-1")?.bytes).toBe(1234);
  });

  test("null sourceHash returns unchanged and does not store", () => {
    const dedupState = createDedupState();
    const result = textResult("stable payload");

    const substituted = maybeSubstitute({
      result,
      processorKey: "git",
      sourceHash: null,
      dedupState,
      processedBytes: 14,
    });

    expect(substituted).toEqual({ result, processorKey: "git" });
    expect(dedupState.records.size).toBe(0);
    expect(dedupState.turnCounter).toBe(0);
  });

  test("undefined result returns unchanged and does not store", () => {
    const dedupState = createDedupState();

    const substituted = maybeSubstitute({
      result: undefined,
      processorKey: "passthrough",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 0,
    });

    expect(substituted).toEqual({ result: undefined, processorKey: "passthrough" });
    expect(dedupState.records.size).toBe(0);
    expect(dedupState.turnCounter).toBe(0);
  });

  test("processedBytes round-trips from first emission into placeholder", () => {
    const dedupState = createDedupState();
    maybeSubstitute({
      result: textResult("stable payload"),
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 1234,
    });

    const substituted = maybeSubstitute({
      result: textResult("stable payload"),
      processorKey: "git",
      sourceHash: "source-1",
      dedupState,
      processedBytes: 14,
    });

    expect(substituted.result?.content?.[0]?.text).toContain("(1234 B)");
  });
});
