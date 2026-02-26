import { describe, expect, test } from "vitest";
import { buildBrainstormingKickoffPrompt } from "../../src/commands/brainstorming-kickoff";

describe("brainstorming kickoff prompt", () => {
  test("includes objective and guardrails", () => {
    const prompt = buildBrainstormingKickoffPrompt("Build login flow with social auth");

    expect(prompt).toContain("Objective: Build login flow with social auth");
    expect(prompt).toContain("Ask one clarifying question at a time");
    expect(prompt).toContain("Propose 2-3 viable approaches");
    expect(prompt).toContain("Do NOT implement code");
    expect(prompt).toContain("explicitly confirms readiness");
    expect(prompt).toContain("Start now with discovery");
  });
});
