import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRunArgs, formatAge } from "../../src/commands/run.js";

describe("parseRunArgs", () => {
  test("returns empty object for undefined args", () => {
    expect(parseRunArgs(undefined)).toEqual({});
  });

  test("returns empty object for empty string", () => {
    expect(parseRunArgs("")).toEqual({});
  });

  test("extracts --profile flag", () => {
    expect(parseRunArgs("--profile fast")).toEqual({ profile: "fast" });
  });

  test("extracts --plan flag", () => {
    expect(parseRunArgs("--plan 2026-03-15-context-mode.md")).toEqual({
      plan: "2026-03-15-context-mode.md",
    });
  });

  test("extracts both --profile and --plan flags", () => {
    expect(
      parseRunArgs("--profile fast --plan my-plan.md"),
    ).toEqual({ profile: "fast", plan: "my-plan.md" });
  });

  test("treats bare string as plan name for backwards compat", () => {
    expect(parseRunArgs("my-plan.md")).toEqual({ plan: "my-plan.md" });
  });

  test("does not treat --profile value as plan name", () => {
    const result = parseRunArgs("--profile fast");
    expect(result.plan).toBeUndefined();
    expect(result.profile).toBe("fast");
  });

  test("rejects flag-like values (--plan --profile fast)", () => {
    const result = parseRunArgs("--plan --profile fast");
    expect(result.plan).toBeUndefined();
    expect(result.profile).toBe("fast");
  });

  test("ignores bare --profile with no value", () => {
    const result = parseRunArgs("--profile");
    expect(result.profile).toBeUndefined();
  });

  test("ignores unknown flags as plan name", () => {
    const result = parseRunArgs("--unknown");
    expect(result.plan).toBeUndefined();
  });
});

describe("formatAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("formats minutes", () => {
    vi.setSystemTime(new Date("2026-03-15T10:30:00Z"));
    expect(formatAge("2026-03-15T10:15:00Z")).toBe("15m");
  });

  test("formats hours and minutes", () => {
    vi.setSystemTime(new Date("2026-03-15T12:45:00Z"));
    expect(formatAge("2026-03-15T10:15:00Z")).toBe("2h 30m");
  });

  test("formats days and hours", () => {
    vi.setSystemTime(new Date("2026-03-17T10:15:00Z"));
    expect(formatAge("2026-03-15T10:15:00Z")).toBe("2d 0h");
  });

  test("clamps future dates to 0m", () => {
    vi.setSystemTime(new Date("2026-03-15T10:00:00Z"));
    expect(formatAge("2026-03-15T10:30:00Z")).toBe("0m");
  });

  test("returns unknown for invalid date", () => {
    expect(formatAge("not-a-date")).toBe("unknown");
  });

  test("formats zero age as 0m", () => {
    vi.setSystemTime(new Date("2026-03-15T10:00:00Z"));
    expect(formatAge("2026-03-15T10:00:00Z")).toBe("0m");
  });
});
