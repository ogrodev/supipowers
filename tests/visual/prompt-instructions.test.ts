import { describe, test, expect } from "vitest";
import { buildVisualInstructions } from "../../src/visual/prompt-instructions.js";

describe("visual prompt instructions", () => {
  test("includes the browser URL", () => {
    const instructions = buildVisualInstructions("http://localhost:51234", "/tmp/session-dir");
    expect(instructions).toContain("http://localhost:51234");
  });

  test("includes the session directory path", () => {
    const instructions = buildVisualInstructions("http://localhost:51234", "/tmp/session-dir");
    expect(instructions).toContain("/tmp/session-dir");
  });

  test("includes CSS class documentation", () => {
    const instructions = buildVisualInstructions("http://localhost:51234", "/tmp/session-dir");
    expect(instructions).toContain(".options");
    expect(instructions).toContain(".option");
    expect(instructions).toContain(".cards");
    expect(instructions).toContain(".mockup");
    expect(instructions).toContain(".split");
    expect(instructions).toContain(".pros-cons");
  });

  test("includes usage guidance for browser vs terminal", () => {
    const instructions = buildVisualInstructions("http://localhost:51234", "/tmp/session-dir");
    expect(instructions).toContain("browser");
    expect(instructions).toContain("terminal");
  });

  test("includes example HTML", () => {
    const instructions = buildVisualInstructions("http://localhost:51234", "/tmp/session-dir");
    expect(instructions).toContain("data-choice");
    expect(instructions).toContain("toggleSelect");
  });

  test("includes .events file reading instructions", () => {
    const instructions = buildVisualInstructions("http://localhost:51234", "/tmp/session-dir");
    expect(instructions).toContain(".events");
  });
});
