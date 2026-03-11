// tests/config/profiles.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProfile, resolveProfile, listProfiles, saveProfile } from "../../src/config/profiles.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { BUILTIN_PROFILES } from "../../src/config/defaults.js";

describe("loadProfile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads built-in profile", () => {
    const profile = loadProfile(tmpDir, "quick");
    expect(profile).toEqual(BUILTIN_PROFILES["quick"]);
  });

  test("returns null for unknown profile", () => {
    expect(loadProfile(tmpDir, "nonexistent")).toBeNull();
  });

  test("custom profile overrides built-in", () => {
    const custom = { ...BUILTIN_PROFILES["quick"], name: "quick", gates: { ...BUILTIN_PROFILES["quick"].gates, codeQuality: true } };
    saveProfile(tmpDir, custom);
    const loaded = loadProfile(tmpDir, "quick");
    expect(loaded?.gates.codeQuality).toBe(true);
  });
});

describe("resolveProfile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves from config default", () => {
    const profile = resolveProfile(tmpDir, DEFAULT_CONFIG);
    expect(profile.name).toBe("thorough");
  });

  test("override takes precedence", () => {
    const profile = resolveProfile(tmpDir, DEFAULT_CONFIG, "quick");
    expect(profile.name).toBe("quick");
  });

  test("falls back to thorough for missing profile", () => {
    const config = { ...DEFAULT_CONFIG, defaultProfile: "missing" };
    const profile = resolveProfile(tmpDir, config);
    expect(profile.name).toBe("thorough");
  });
});

describe("listProfiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("lists built-in profiles", () => {
    const profiles = listProfiles(tmpDir);
    expect(profiles).toContain("quick");
    expect(profiles).toContain("thorough");
    expect(profiles).toContain("full-regression");
  });

  test("includes custom profiles", () => {
    saveProfile(tmpDir, { ...BUILTIN_PROFILES["quick"], name: "custom" });
    const profiles = listProfiles(tmpDir);
    expect(profiles).toContain("custom");
  });
});
