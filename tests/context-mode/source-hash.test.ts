// tests/context-mode/source-hash.test.ts
import { describe, expect, test } from "bun:test";
import { uniqueSourceHash } from "../../src/context-mode/source-hash.js";

describe("uniqueSourceHash — read/open path canonicalization", () => {
  test("backslash and forward-slash relative paths produce the same hash", () => {
    const a = uniqueSourceHash({
      tool: "read",
      input: { path: "src\\foo\\bar.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    const b = uniqueSourceHash({
      tool: "read",
      input: { path: "src/foo/bar.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  test("relative path under cwd hashes identically to its absolute form", () => {
    const rel = uniqueSourceHash({
      tool: "read",
      input: { path: "src/foo/bar.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    const abs = uniqueSourceHash({
      tool: "read",
      input: { path: "/repo/src/foo/bar.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(rel).toBe(abs);
  });

  test("Windows drive-letter absolute paths match the relative+cwd form", () => {
    const rel = uniqueSourceHash({
      tool: "read",
      input: { path: "src\\foo\\bar.ts" },
      cwd: "C:\\repo",
      projectSlug: "demo",
    });
    const abs = uniqueSourceHash({
      tool: "read",
      input: { path: "C:\\repo\\src\\foo\\bar.ts" },
      cwd: "C:\\repo",
      projectSlug: "demo",
    });
    expect(rel).toBe(abs);
  });

  test("UNC prefix is detected as absolute and not joined with cwd", () => {
    const a = uniqueSourceHash({
      tool: "read",
      input: { path: "\\\\server\\share\\foo.ts" },
      cwd: "C:\\repo",
      projectSlug: "demo",
    });
    const b = uniqueSourceHash({
      tool: "read",
      input: { path: "//server/share/foo.ts" },
      cwd: "C:\\repo",
      projectSlug: "demo",
    });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  test("salt isolation: same path with different projectSlug produces different hashes", () => {
    const p1 = uniqueSourceHash({
      tool: "read",
      input: { path: "src/foo.ts" },
      cwd: "/repo",
      projectSlug: "p1",
    });
    const p2 = uniqueSourceHash({
      tool: "read",
      input: { path: "src/foo.ts" },
      cwd: "/repo",
      projectSlug: "p2",
    });
    expect(p1).not.toBe(p2);
    expect(p1).not.toBeNull();
  });

  test("`open` is treated identically to `read` (canonical alias)", () => {
    const r = uniqueSourceHash({
      tool: "read",
      input: { path: "src/foo.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    const o = uniqueSourceHash({
      tool: "open",
      input: { path: "src/foo.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(o).toBe(r);
  });
});

describe("uniqueSourceHash — bash command truncation", () => {
  test("trailing arguments past the 4th token are dropped before hashing", () => {
    const a = uniqueSourceHash({
      tool: "bash",
      input: { command: 'bash -lc "git status; echo $SECRET"' },
      cwd: "/repo",
      projectSlug: "demo",
    });
    const b = uniqueSourceHash({
      tool: "bash",
      input: { command: 'bash -lc "git status; echo other"' },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  test("commands with different head tokens hash differently", () => {
    const a = uniqueSourceHash({
      tool: "bash",
      input: { command: "bun run typecheck" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    const b = uniqueSourceHash({
      tool: "bash",
      input: { command: "bun run test" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(a).not.toBe(b);
  });

  test("salt isolation also applies to bash hashes", () => {
    const p1 = uniqueSourceHash({
      tool: "bash",
      input: { command: "git status" },
      cwd: "/repo",
      projectSlug: "p1",
    });
    const p2 = uniqueSourceHash({
      tool: "bash",
      input: { command: "git status" },
      cwd: "/repo",
      projectSlug: "p2",
    });
    expect(p1).not.toBe(p2);
  });
});

describe("uniqueSourceHash — find / search / unknown", () => {
  test("find hashes the paths array with project salt", () => {
    const p1 = uniqueSourceHash({
      tool: "find",
      input: { paths: ["*.ts"] },
      cwd: "/repo",
      projectSlug: "p1",
    });
    const p2 = uniqueSourceHash({
      tool: "find",
      input: { paths: ["*.ts"] },
      cwd: "/repo",
      projectSlug: "p2",
    });
    expect(p1).not.toBe(p2);
    expect(p1).not.toBeNull();
  });

  test("search without paths falls back to pattern-only hash", () => {
    const a = uniqueSourceHash({
      tool: "search",
      input: { pattern: "TODO" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(a).not.toBeNull();
  });

  test("search hashes paths array order-sensitively with project salt", () => {
    const ab = uniqueSourceHash({
      tool: "search",
      input: { paths: ["a/", "b/"], pattern: "x" },
      cwd: "/repo",
      projectSlug: "p",
    });
    const ba = uniqueSourceHash({
      tool: "search",
      input: { paths: ["b/", "a/"], pattern: "x" },
      cwd: "/repo",
      projectSlug: "p",
    });
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    expect(ab).not.toBe(ba);
  });

  test("search distinguishes patterns even when paths match", () => {
    const todo = uniqueSourceHash({
      tool: "search",
      input: { paths: ["src/"], pattern: "TODO" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    const fixme = uniqueSourceHash({
      tool: "search",
      input: { paths: ["src/"], pattern: "FIXME" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(todo).not.toBeNull();
    expect(fixme).not.toBeNull();
    expect(todo).not.toBe(fixme);
  });

  test("search legacy `path: string` is still accepted (pre-14.6.0 fallback)", () => {
    // TODO(omp-14.7): drop this test together with the legacy fallback.
    const h = uniqueSourceHash({
      tool: "search",
      input: { path: "src/", pattern: "TODO" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(h).not.toBeNull();
  });

  test("find hashes paths array, distinct across project slugs", () => {
    const p1 = uniqueSourceHash({
      tool: "find",
      input: { paths: ["**/*.ts"] },
      cwd: "/repo",
      projectSlug: "p1",
    });
    const p2 = uniqueSourceHash({
      tool: "find",
      input: { paths: ["**/*.ts"] },
      cwd: "/repo",
      projectSlug: "p2",
    });
    expect(p1).not.toBe(p2);
    expect(p1).not.toBeNull();
  });

  test("find legacy `pattern: string` is still accepted (pre-14.6.0 fallback)", () => {
    // TODO(omp-14.7): drop this test together with the legacy fallback.
    const h = uniqueSourceHash({
      tool: "find",
      input: { pattern: "*.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(h).not.toBeNull();
  });

  test("unknown tool returns null", () => {
    const h = uniqueSourceHash({
      tool: "noSuchTool",
      input: { path: "src/foo.ts" },
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(h).toBeNull();
  });

  test("missing input keys return null for tools that need them", () => {
    const r = uniqueSourceHash({
      tool: "read",
      input: {},
      cwd: "/repo",
      projectSlug: "demo",
    });
    expect(r).toBeNull();
  });
});
