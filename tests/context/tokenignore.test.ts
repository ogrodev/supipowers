import { describe, expect, test } from "bun:test";
import {
  TOKENIGNORE_BEGIN_MARKER,
  TOKENIGNORE_END_MARKER,
  hashTokenignoreEntries,
  mergeManagedTokenignore,
  parseManagedTokenignore,
  renderManagedTokenignoreBlock,
} from "../../src/context/tokenignore.js";

const ENTRIES = [".omp/supipowers/reviews/", ".omp/supipowers/debug/", "dist/"];

describe("hashTokenignoreEntries", () => {
  test("deduplicates and sorts entries before hashing", () => {
    expect(hashTokenignoreEntries(["dist/", "dist/", ".cache/"])).toBe(
      hashTokenignoreEntries([".cache/", "dist/"]),
    );
    expect(hashTokenignoreEntries(["dist/"])).not.toBe(hashTokenignoreEntries(["build/"]));
  });
});

describe("renderManagedTokenignoreBlock", () => {
  test("renders begin/end markers, hash, and deduplicated entries", () => {
    const block = renderManagedTokenignoreBlock(["dist/", "dist/", " .cache/ ", ""]);
    expect(block).toContain(TOKENIGNORE_BEGIN_MARKER);
    expect(block).toContain(TOKENIGNORE_END_MARKER);
    expect(block).toContain(`# hash: ${hashTokenignoreEntries(["dist/", ".cache/"])}`);
    expect(block.match(/^dist\/$/gm)).toHaveLength(1);
    expect(block.match(/^\.cache\/$/gm)).toHaveLength(1);
  });
});

describe("mergeManagedTokenignore", () => {
  test("creates a new tokenignore file from only the managed block", () => {
    const result = mergeManagedTokenignore(null, ENTRIES);
    expect(result.entries).toEqual(ENTRIES);
    expect(result.hash).toBe(hashTokenignoreEntries(ENTRIES));
    expect(result.content.startsWith(TOKENIGNORE_BEGIN_MARKER)).toBe(true);
    expect(result.content.endsWith("\n")).toBe(true);
  });

  test("adds the managed block after user content", () => {
    const result = mergeManagedTokenignore("# user rules\ncoverage/\n", ENTRIES);
    expect(result.content).toContain("# user rules\ncoverage/");
    expect(result.content.indexOf("coverage/")).toBeLessThan(result.content.indexOf(TOKENIGNORE_BEGIN_MARKER));
    expect(parseManagedTokenignore(result.content)).toMatchObject({
      status: "managed",
      hash: hashTokenignoreEntries(ENTRIES),
      entries: ENTRIES,
    });
  });

  test("replaces an existing managed block", () => {
    const old = mergeManagedTokenignore("logs/\n", ["old-entry/"]).content;
    const result = mergeManagedTokenignore(old, ["new-entry/"]);
    expect(result.content).toContain("logs/");
    expect(result.content).not.toContain("old-entry/");
    expect(result.content).toContain("new-entry/");
    expect(result.content.match(new RegExp(TOKENIGNORE_BEGIN_MARKER, "g"))).toHaveLength(1);
  });

  test("deduplicates managed entries while preserving first occurrence order", () => {
    const result = mergeManagedTokenignore("", ["b/", "a/", "b/", " a/ ", "c/"]);
    expect(result.entries).toEqual(["b/", "a/", "c/"]);
    expect(parseManagedTokenignore(result.content)).toMatchObject({
      status: "managed",
      entries: ["b/", "a/", "c/"],
    });
  });

  test("preserves user-authored lines outside the managed block", () => {
    const existing = [
      "# keep this comment",
      "node_modules/",
      TOKENIGNORE_BEGIN_MARKER,
      "# hash: stale",
      "old/",
      TOKENIGNORE_END_MARKER,
      "# keep trailing comment",
      "tmp/",
      "",
    ].join("\n");

    const result = mergeManagedTokenignore(existing, ["managed/"]);
    expect(result.content).toContain("# keep this comment");
    expect(result.content).toContain("node_modules/");
    expect(result.content).toContain("# keep trailing comment");
    expect(result.content).toContain("tmp/");
    expect(result.content).not.toContain("old/");
    expect(result.content).toContain("managed/");
  });
});
