import { describe, expect, test } from "bun:test";
import path from "node:path";
import { SLUG_SCHEMA_VERSION, projectSlugFromRepoRoot } from "../../src/workspace/project-slug.js";

describe("projectSlugFromRepoRoot", () => {
  test("returns identical slug for identical absolute repo root", () => {
    const a = projectSlugFromRepoRoot("/Users/alice/code/supipowers");
    const b = projectSlugFromRepoRoot("/Users/alice/code/supipowers");

    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("returns distinct slugs for absolute paths that differ only in case", () => {
    // On case-sensitive filesystems these are different directories.
    // The slug must preserve that distinction and must never silently collide.
    const upper = projectSlugFromRepoRoot("/Users/Alice/code/supipowers");
    const lower = projectSlugFromRepoRoot("/users/alice/code/supipowers");

    expect(upper).not.toBe(lower);
  });

  test("returns distinct slugs for distinct absolute repo roots even with the same basename", () => {
    const a = projectSlugFromRepoRoot("/Users/alice/code/supipowers");
    const b = projectSlugFromRepoRoot("/Users/bob/code/supipowers");

    expect(a).not.toBe(b);
  });

  test("returns distinct slugs for two clones of the same repo at different absolute roots", () => {
    // Prevent the "two clones collide in the global projects dir" regression.
    const repoA = projectSlugFromRepoRoot("/tmp/clones/repo-a");
    const repoB = projectSlugFromRepoRoot("/tmp/clones/repo-b");

    expect(repoA).not.toBe(repoB);
  });

  test("is normalization-stable: trailing slash or redundant separators do not change the slug", () => {
    const canonical = projectSlugFromRepoRoot("/Users/alice/code/supipowers");
    const withTrailing = projectSlugFromRepoRoot("/Users/alice/code/supipowers/");
    const withDoubled = projectSlugFromRepoRoot("/Users/alice/code//supipowers");

    expect(withTrailing).toBe(canonical);
    expect(withDoubled).toBe(canonical);
  });

  test("incorporates a human-readable basename portion in the slug", () => {
    const slug = projectSlugFromRepoRoot("/Users/alice/code/My Cool Repo");

    // Human-readable portion must appear (sanitized) before the hash portion.
    expect(slug.startsWith("my-cool-repo-")).toBe(true);
    // The hash portion must be a stable-length hex suffix.
    const suffix = slug.slice("my-cool-repo-".length);
    expect(suffix).toMatch(/^[0-9a-f]+$/);
    expect(suffix.length).toBeGreaterThanOrEqual(8);
  });

  test("throws when repo root is not absolute", () => {
    expect(() => projectSlugFromRepoRoot("relative/path")).toThrow(/absolute/i);
    expect(() => projectSlugFromRepoRoot("./still/relative")).toThrow(/absolute/i);
  });

  test("throws when repo root is empty or whitespace-only", () => {
    expect(() => projectSlugFromRepoRoot("")).toThrow();
    expect(() => projectSlugFromRepoRoot("   ")).toThrow();
  });

  test("is deterministic for the same absolute input across calls", () => {
    const input = path.resolve("/tmp/supi-slug/determinism");
    const runs = Array.from({ length: 8 }, () => projectSlugFromRepoRoot(input));
    const unique = new Set(runs);
    expect(unique.size).toBe(1);
  });

  test("SLUG_SCHEMA_VERSION is 1 and is frozen until a migration lands", () => {
    expect(SLUG_SCHEMA_VERSION).toBe(1);
  });
});
