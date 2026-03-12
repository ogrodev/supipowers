import { describe, test, expect } from "vitest";
import { buildDiscoveryPrompt } from "../../../src/qa/phases/discovery.js";

describe("discovery phase prompt", () => {
  test("includes framework name and command", () => {
    const prompt = buildDiscoveryPrompt({ name: "vitest", command: "npx vitest run" }, "/project");
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("npx vitest run");
  });

  test("includes project path", () => {
    const prompt = buildDiscoveryPrompt({ name: "jest", command: "npx jest" }, "/my/project");
    expect(prompt).toContain("/my/project");
  });

  test("requests structured JSON output", () => {
    const prompt = buildDiscoveryPrompt({ name: "vitest", command: "npx vitest run" }, "/project");
    expect(prompt).toContain("filePath");
    expect(prompt).toContain("testName");
    expect(prompt).toContain("JSON");
  });

  test("includes auto-chain instruction", () => {
    const prompt = buildDiscoveryPrompt({ name: "vitest", command: "npx vitest run" }, "/project");
    expect(prompt).toContain("/supi:qa");
  });
});
