import { describe, it, expect } from "vitest";
import { detectPlatform } from "../../src/platform/detect.js";

describe("detectPlatform", () => {
  it("returns 'omp' when rawApi has pi.createAgentSession", () => {
    const rawApi = { pi: { createAgentSession: () => {} }, registerCommand: () => {} };
    expect(detectPlatform(rawApi)).toBe("omp");
  });

  it("returns 'pi' when rawApi lacks pi.createAgentSession", () => {
    const rawApi = { registerCommand: () => {}, getActiveTools: () => [] };
    expect(detectPlatform(rawApi)).toBe("pi");
  });

  it("returns 'pi' when rawApi.pi exists but has no createAgentSession", () => {
    const rawApi = { pi: { somethingElse: true }, registerCommand: () => {} };
    expect(detectPlatform(rawApi)).toBe("pi");
  });

  it("returns 'pi' for empty object", () => {
    expect(detectPlatform({})).toBe("pi");
  });
});
