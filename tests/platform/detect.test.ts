
import { detectPlatform } from "../../src/platform/detect.js";

describe("detectPlatform", () => {
  it("returns 'omp' when rawApi has pi.createAgentSession", () => {
    const rawApi = { pi: { createAgentSession: () => {} }, registerCommand: () => {} };
    expect(detectPlatform(rawApi)).toBe("omp");
  });

  it("throws when rawApi lacks pi.createAgentSession", () => {
    const rawApi = { registerCommand: () => {}, getActiveTools: () => [] };
    expect(() => detectPlatform(rawApi)).toThrow("Unrecognized API shape");
  });

  it("throws when rawApi.pi exists but has no createAgentSession", () => {
    const rawApi = { pi: { somethingElse: true }, registerCommand: () => {} };
    expect(() => detectPlatform(rawApi)).toThrow("Unrecognized API shape");
  });

  it("throws for empty object", () => {
    expect(() => detectPlatform({})).toThrow("Unrecognized API shape");
  });
});
