import { describe, expect, test } from "bun:test";
import type {
  ContextModeProcessorFamily,
  ContextModeProcessorsConfig,
} from "../../../src/types.js";
import type {
  Processor,
  ProcessorContext,
  ProcessorInvariant,
  ProcessorOutput,
} from "../../../src/context-mode/processors/types.js";

const ALL_PROCESSOR_FAMILIES: ContextModeProcessorFamily[] = [
  "git",
  "test",
  "lint",
  "build",
  "k8s",
  "docker",
  "log",
  "json",
];

describe("context-mode processor types", () => {
  test("accepts every L2 processor family key", () => {
    const config: ContextModeProcessorsConfig = {
      enabled: true,
      disable: ALL_PROCESSOR_FAMILIES,
    };

    expect(config.disable).toEqual([
      "git",
      "test",
      "lint",
      "build",
      "k8s",
      "docker",
      "log",
      "json",
    ]);
  });

  test("processor artifacts preserve the family key", () => {
    const invariant: ProcessorInvariant = {
      key: "git",
      maxBytes: 4096,
      preserve: ["branch", "paths"],
    };
    const context: ProcessorContext = { exitCode: 0, eol: "\r\n" };
    const processor: Processor = (_text, ctx) => ({
      text: `compressed${ctx.eol}`,
      processorKey: invariant.key,
      passthrough: false,
    });
    const output: ProcessorOutput = processor("input", context);

    expect(output).toEqual({
      text: "compressed\r\n",
      processorKey: "git",
      passthrough: false,
    });
  });
});
