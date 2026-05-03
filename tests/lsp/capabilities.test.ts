// tests/lsp/capabilities.test.ts
import { describe, expect, mock, test } from "bun:test";
import type { AgentSession } from "../../src/platform/types.js";
import {
  FULL_LSP_SUPPORT,
  NO_LSP_SUPPORT,
  probeLspCapabilities,
} from "../../src/lsp/capabilities.js";

/**
 * Minimal agent-session factory mirroring tests/lsp/bridge.test.ts. Each
 * `runWithOutputValidation` attempt creates one session whose final
 * assistant message is the next entry in `finalTexts`. After the array is
 * exhausted, the last entry is reused (sticks).
 */
function createAgentSessionFactory(finalTexts: string[]) {
  const calls: any[] = [];
  let index = 0;
  const factory = mock(async (options: any) => {
    calls.push(options);
    const text = finalTexts[Math.min(index, finalTexts.length - 1)];
    index += 1;
    const session: AgentSession = {
      subscribe: () => () => {},
      prompt: async () => {},
      state: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "text", text }] },
        ],
      },
      dispose: async () => {},
    } as unknown as AgentSession;
    return session;
  });
  return { factory, calls };
}

describe("probeLspCapabilities", () => {
  test("parses canonical capabilities JSON on the first attempt", async () => {
    const { factory, calls } = createAgentSessionFactory([JSON.stringify(FULL_LSP_SUPPORT)]);

    const caps = await probeLspCapabilities({
      cwd: "/tmp/project",
      createAgentSession: factory as any,
    });

    expect(calls).toHaveLength(1);
    expect(caps).toEqual(FULL_LSP_SUPPORT);
  });

  test("parses partial-capability response with diagnostics:false", async () => {
    const partial = {
      diagnostics: false,
      references: true,
      definition: true,
      hover: true,
      rename: false,
    };
    const { factory } = createAgentSessionFactory([JSON.stringify(partial)]);

    const caps = await probeLspCapabilities({
      cwd: "/tmp/project",
      createAgentSession: factory as any,
    });

    expect(caps).toEqual(partial);
  });

  test("returns NO_LSP_SUPPORT when the validator never produces valid output", async () => {
    // 3 retry attempts of garbage will exhaust the structured-output runner;
    // the helper must return NO_LSP_SUPPORT instead of throwing.
    const { factory, calls } = createAgentSessionFactory(["not json"]);

    const caps = await probeLspCapabilities({
      cwd: "/tmp/project",
      createAgentSession: factory as any,
    });

    expect(caps).toEqual(NO_LSP_SUPPORT);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test("returns NO_LSP_SUPPORT when the agent factory throws", async () => {
    const factory = mock(async () => {
      throw new Error("agent unavailable");
    });

    const caps = await probeLspCapabilities({
      cwd: "/tmp/project",
      createAgentSession: factory as any,
    });

    expect(caps).toEqual(NO_LSP_SUPPORT);
  });

  test("treats schema-mismatched payloads as fail-closed", async () => {
    // Missing `rename` field → schema invalid; helper must not throw.
    const bad = JSON.stringify({
      diagnostics: true,
      references: true,
      definition: true,
      hover: true,
      // rename intentionally omitted
    });
    const { factory } = createAgentSessionFactory([bad]);

    const caps = await probeLspCapabilities({
      cwd: "/tmp/project",
      createAgentSession: factory as any,
    });

    expect(caps).toEqual(NO_LSP_SUPPORT);
  });
});
