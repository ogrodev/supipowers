// tests/release/changelog.test.ts

import {
  parseConventionalCommits,
  buildChangelogMarkdown,
  summarizeChanges,
} from "../../src/release/changelog.js";

// ---------------------------------------------------------------------------
// parseConventionalCommits
// ---------------------------------------------------------------------------

describe("parseConventionalCommits", () => {
  describe("empty / blank input", () => {
    test("empty string returns all-empty arrays", () => {
      const result = parseConventionalCommits("");
      expect(result).toEqual({ features: [], fixes: [], breaking: [], other: [] });
    });

    test("only blank lines returns all-empty arrays", () => {
      const result = parseConventionalCommits("\n\n   \n");
      expect(result).toEqual({ features: [], fixes: [], breaking: [], other: [] });
    });
  });

  describe("feat commits", () => {
    test("simple feat goes to features", () => {
      const result = parseConventionalCommits("abc1234 feat: add login page");
      expect(result.features).toHaveLength(1);
      expect(result.features[0]).toEqual({
        hash: "abc1234",
        message: "add login page",
      });
      expect(result.breaking).toHaveLength(0);
    });

    test("scoped feat extracts scope and strips prefix", () => {
      const result = parseConventionalCommits("def5678 feat(auth): implement OAuth");
      expect(result.features[0]).toEqual({
        hash: "def5678",
        message: "implement OAuth",
        scope: "auth",
      });
    });
  });

  describe("fix commits", () => {
    test("simple fix goes to fixes", () => {
      const result = parseConventionalCommits("aaa0001 fix: null pointer in login");
      expect(result.fixes).toHaveLength(1);
      expect(result.fixes[0]).toEqual({
        hash: "aaa0001",
        message: "null pointer in login",
      });
    });

    test("scoped fix extracts scope", () => {
      const result = parseConventionalCommits("bbb0002 fix(api): handle 500 errors");
      expect(result.fixes[0]).toMatchObject({ scope: "api", message: "handle 500 errors" });
    });
  });

  describe("breaking commits", () => {
    test("feat! goes to breaking AND features", () => {
      const result = parseConventionalCommits("ccc0003 feat!: redesign auth API");
      expect(result.breaking).toHaveLength(1);
      expect(result.features).toHaveLength(1);
      expect(result.breaking[0]).toMatchObject({ hash: "ccc0003", message: "redesign auth API" });
      expect(result.fixes).toHaveLength(0);
    });

    test("scoped feat(scope)! goes to breaking AND features with scope", () => {
      const result = parseConventionalCommits("ddd0004 feat(core)!: remove legacy endpoint");
      expect(result.breaking[0]).toMatchObject({ scope: "core", message: "remove legacy endpoint" });
      expect(result.features[0]).toMatchObject({ scope: "core" });
    });

    test("fix! goes to breaking AND fixes", () => {
      const result = parseConventionalCommits("eee0005 fix!: change error response shape");
      expect(result.breaking).toHaveLength(1);
      expect(result.fixes).toHaveLength(1);
    });

    test("BREAKING CHANGE: footer line goes to breaking (regardless of type)", () => {
      const result = parseConventionalCommits(
        "fff0006 chore: update deps BREAKING CHANGE: removed old API"
      );
      expect(result.breaking).toHaveLength(1);
      expect(result.features).toHaveLength(0);
      expect(result.fixes).toHaveLength(0);
      // raw line (not stripped) since no conventional prefix matched after footer test
      expect(result.breaking[0].hash).toBe("fff0006");
    });

    test("BREAKING-CHANGE: (hyphen variant) goes to breaking", () => {
      const result = parseConventionalCommits(
        "aaa9999 docs: update readme BREAKING-CHANGE: new format required"
      );
      expect(result.breaking).toHaveLength(1);
    });
  });

  describe("other commits", () => {
    test("non-conventional message goes to other", () => {
      const result = parseConventionalCommits("ggg0007 Merge pull request #42");
      expect(result.other).toHaveLength(1);
      expect(result.other[0]).toEqual({ hash: "ggg0007", message: "Merge pull request #42" });
    });

    test("conventional type that is not feat/fix goes to other", () => {
      const result = parseConventionalCommits("hhh0008 chore: update dependencies");
      expect(result.other).toHaveLength(1);
    });

    test("docs commit goes to other", () => {
      const result = parseConventionalCommits("iii0009 docs(readme): fix typo");
      expect(result.other).toHaveLength(1);
    });

    test("refactor commit goes to other", () => {
      const result = parseConventionalCommits("jjj0010 refactor(core): simplify loop");
      expect(result.other).toHaveLength(1);
    });
  });

  describe("multi-line input", () => {
    test("parses each line independently", () => {
      const log = [
        "aaa0001 feat: add widget",
        "bbb0002 fix(db): fix connection leak",
        "ccc0003 chore: bump version",
        "",
        "ddd0004 feat(ui)!: redesign button",
      ].join("\n");

      const result = parseConventionalCommits(log);
      expect(result.features).toHaveLength(2); // feat + feat!
      expect(result.fixes).toHaveLength(1);
      expect(result.breaking).toHaveLength(1);
      expect(result.other).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// buildChangelogMarkdown
// ---------------------------------------------------------------------------

describe("buildChangelogMarkdown", () => {
  const baseCommits = {
    features: [{ hash: "abc1234", message: "add dark mode", scope: "ui" }],
    fixes: [{ hash: "def5678", message: "null pointer in parser" }],
    breaking: [],
    other: [],
  };

  test("starts with ## v{version} header", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.2.3");
    expect(md).toMatch(/^## v1\.2\.3/);
  });

  test("includes today's date in YYYY-MM-DD format", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.0.0");
    const today = new Date().toISOString().slice(0, 10);
    expect(md).toContain(today);
  });

  test("features section has correct header and entry", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.0.0");
    expect(md).toContain("### ✨ Features");
    expect(md).toContain("- add dark mode (ui) `abc1234`");
  });

  test("fixes section has correct header and entry without scope", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.0.0");
    expect(md).toContain("### 🐛 Fixes");
    expect(md).toContain("- null pointer in parser `def5678`");
  });

  test("empty sections are omitted", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.0.0");
    expect(md).not.toContain("### 🚨 Breaking Changes");
    expect(md).not.toContain("### 📦 Other");
  });

  test("breaking section appears when present", () => {
    const commits = {
      ...baseCommits,
      breaking: [{ hash: "bbb0002", message: "remove legacy API", scope: "core" }],
    };
    const md = buildChangelogMarkdown(commits, "2.0.0");
    expect(md).toContain("### 🚨 Breaking Changes");
    expect(md).toContain("- remove legacy API (core) `bbb0002`");
  });

  test("entry without scope omits parentheses", () => {
    const commits = {
      features: [{ hash: "abc1234", message: "add feature" }],
      fixes: [],
      breaking: [],
      other: [],
    };
    const md = buildChangelogMarkdown(commits, "1.0.0");
    expect(md).toContain("- add feature `abc1234`");
    expect(md).not.toMatch(/- add feature \(\)/);
  });

  test("all sections empty still has header and date", () => {
    const empty = { features: [], fixes: [], breaking: [], other: [] };
    const md = buildChangelogMarkdown(empty, "0.0.1");
    expect(md).toMatch(/^## v0\.0\.1/);
    expect(md).not.toContain("###");
  });
});

// ---------------------------------------------------------------------------
// summarizeChanges
// ---------------------------------------------------------------------------

describe("summarizeChanges", () => {
  test("all empty returns 'no changes found'", () => {
    expect(
      summarizeChanges({ features: [], fixes: [], breaking: [], other: [] })
    ).toBe("no changes found");
  });

  test("single feature uses singular", () => {
    expect(
      summarizeChanges({
        features: [{ hash: "a", message: "x" }],
        fixes: [],
        breaking: [],
        other: [],
      })
    ).toBe("1 feature");
  });

  test("multiple features use plural", () => {
    expect(
      summarizeChanges({
        features: [
          { hash: "a", message: "x" },
          { hash: "b", message: "y" },
        ],
        fixes: [],
        breaking: [],
        other: [],
      })
    ).toBe("2 features");
  });

  test("single fix uses singular", () => {
    expect(
      summarizeChanges({
        features: [],
        fixes: [{ hash: "a", message: "x" }],
        breaking: [],
        other: [],
      })
    ).toBe("1 fix");
  });

  test("multiple fixes use plural", () => {
    expect(
      summarizeChanges({
        features: [],
        fixes: [
          { hash: "a", message: "x" },
          { hash: "b", message: "y" },
          { hash: "c", message: "z" },
        ],
        breaking: [],
        other: [],
      })
    ).toBe("3 fixes");
  });

  test("single breaking change uses singular", () => {
    expect(
      summarizeChanges({
        features: [],
        fixes: [],
        breaking: [{ hash: "a", message: "x" }],
        other: [],
      })
    ).toBe("1 breaking change");
  });

  test("multiple breaking changes use plural", () => {
    expect(
      summarizeChanges({
        features: [],
        fixes: [],
        breaking: [{ hash: "a", message: "x" }, { hash: "b", message: "y" }],
        other: [],
      })
    ).toBe("2 breaking changes");
  });

  test("mixed: features, fixes, breaking", () => {
    expect(
      summarizeChanges({
        features: [{ hash: "a", message: "x" }, { hash: "b", message: "y" }, { hash: "c", message: "z" }],
        fixes: [{ hash: "d", message: "w" }, { hash: "e", message: "v" }],
        breaking: [{ hash: "f", message: "u" }],
        other: [],
      })
    ).toBe("3 features, 2 fixes, 1 breaking change");
  });

  test("other commits are not counted in summary", () => {
    const result = summarizeChanges({
      features: [],
      fixes: [],
      breaking: [],
      other: [{ hash: "a", message: "chore" }, { hash: "b", message: "docs" }],
    });
    expect(result).toBe("no changes found");
  });

  test("features and fixes but no breaking", () => {
    expect(
      summarizeChanges({
        features: [{ hash: "a", message: "x" }],
        fixes: [{ hash: "b", message: "y" }],
        breaking: [],
        other: [],
      })
    ).toBe("1 feature, 1 fix");
  });
});
