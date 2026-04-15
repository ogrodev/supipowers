// tests/release/changelog.test.ts

import {
  parseConventionalCommits,
  buildChangelogMarkdown,
  summarizeChanges,
  filterOnelineGitLogToPaths,
} from "../../src/release/changelog.js";
import type { CategorizedCommits } from "../../src/types.js";

/** Shorthand for a fully-initialized empty CategorizedCommits */
function emptyCommits(): CategorizedCommits {
  return {
    features: [],
    fixes: [],
    breaking: [],
    improvements: [],
    maintenance: [],
    other: [],
  };
}

// ---------------------------------------------------------------------------
// parseConventionalCommits
// ---------------------------------------------------------------------------

describe("parseConventionalCommits", () => {
  describe("empty / blank input", () => {
    test("empty string returns all-empty arrays", () => {
      const result = parseConventionalCommits("");
      expect(result).toEqual(emptyCommits());
    });

    test("only blank lines returns all-empty arrays", () => {
      const result = parseConventionalCommits("\n\n   \n");
      expect(result).toEqual(emptyCommits());
    });
  });

  describe("feat commits", () => {
    test("simple feat goes to features", () => {
      const result = parseConventionalCommits("abc1234 feat: add login page");
      expect(result.features).toHaveLength(1);
      expect(result.features[0]).toEqual({
        hash: "abc1234",
        message: "add login page",
        type: "feat",
      });
      expect(result.breaking).toHaveLength(0);
    });

    test("scoped feat extracts scope and strips prefix", () => {
      const result = parseConventionalCommits("def5678 feat(auth): implement OAuth");
      expect(result.features[0]).toEqual({
        hash: "def5678",
        message: "implement OAuth",
        scope: "auth",
        type: "feat",
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
        type: "fix",
      });
    });

    test("scoped fix extracts scope", () => {
      const result = parseConventionalCommits("bbb0002 fix(api): handle 500 errors");
      expect(result.fixes[0]).toMatchObject({ scope: "api", message: "handle 500 errors", type: "fix" });
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

    test("refactor! goes to breaking AND improvements", () => {
      const result = parseConventionalCommits("rrr0001 refactor!: rewrite auth module");
      expect(result.breaking).toHaveLength(1);
      expect(result.improvements).toHaveLength(1);
      expect(result.improvements[0]).toMatchObject({ message: "rewrite auth module", type: "refactor" });
    });

    test("perf! goes to breaking AND improvements", () => {
      const result = parseConventionalCommits("ppp0001 perf!: change cache key format");
      expect(result.breaking).toHaveLength(1);
      expect(result.improvements).toHaveLength(1);
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

  describe("improvement commits", () => {
    test("refactor goes to improvements", () => {
      const result = parseConventionalCommits("jjj0010 refactor(core): simplify loop");
      expect(result.improvements).toHaveLength(1);
      expect(result.improvements[0]).toMatchObject({
        message: "simplify loop",
        scope: "core",
        type: "refactor",
      });
      expect(result.other).toHaveLength(0);
    });

    test("perf goes to improvements", () => {
      const result = parseConventionalCommits("ppp0002 perf: reduce bundle size");
      expect(result.improvements).toHaveLength(1);
      expect(result.improvements[0]).toMatchObject({ type: "perf", message: "reduce bundle size" });
    });

    test("revert goes to improvements", () => {
      const result = parseConventionalCommits("rvv0001 revert: undo widget change");
      expect(result.improvements).toHaveLength(1);
      expect(result.improvements[0]).toMatchObject({ type: "revert" });
    });
  });

  describe("maintenance commits", () => {
    test("chore goes to maintenance", () => {
      const result = parseConventionalCommits("hhh0008 chore: update dependencies");
      expect(result.maintenance).toHaveLength(1);
      expect(result.maintenance[0]).toMatchObject({ type: "chore" });
      expect(result.other).toHaveLength(0);
    });

    test("docs goes to maintenance", () => {
      const result = parseConventionalCommits("iii0009 docs(readme): fix typo");
      expect(result.maintenance).toHaveLength(1);
      expect(result.maintenance[0]).toMatchObject({ type: "docs", scope: "readme" });
    });

    test("ci goes to maintenance", () => {
      const result = parseConventionalCommits("ccc0010 ci: add GitHub Actions workflow");
      expect(result.maintenance).toHaveLength(1);
      expect(result.maintenance[0]).toMatchObject({ type: "ci" });
    });

    test("build goes to maintenance", () => {
      const result = parseConventionalCommits("bbb0010 build: upgrade webpack");
      expect(result.maintenance).toHaveLength(1);
      expect(result.maintenance[0]).toMatchObject({ type: "build" });
    });

    test("test goes to maintenance", () => {
      const result = parseConventionalCommits("ttt0010 test: add unit tests for parser");
      expect(result.maintenance).toHaveLength(1);
      expect(result.maintenance[0]).toMatchObject({ type: "test" });
    });

    test("style goes to maintenance", () => {
      const result = parseConventionalCommits("sss0010 style: fix whitespace");
      expect(result.maintenance).toHaveLength(1);
      expect(result.maintenance[0]).toMatchObject({ type: "style" });
    });
  });

  describe("other commits", () => {
    test("non-conventional message goes to other", () => {
      const result = parseConventionalCommits("ggg0007 Merge pull request #42");
      expect(result.other).toHaveLength(1);
      expect(result.other[0]).toEqual({ hash: "ggg0007", message: "Merge pull request #42" });
    });

    test("unknown conventional type goes to other", () => {
      const result = parseConventionalCommits("xxx0001 wip: work in progress");
      expect(result.other).toHaveLength(1);
      expect(result.other[0]).toMatchObject({ type: "wip" });
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
        "eee0005 refactor: extract helper",
      ].join("\n");

      const result = parseConventionalCommits(log);
      expect(result.features).toHaveLength(2); // feat + feat!
      expect(result.fixes).toHaveLength(1);
      expect(result.breaking).toHaveLength(1);
      expect(result.maintenance).toHaveLength(1); // chore
      expect(result.improvements).toHaveLength(1); // refactor
      expect(result.other).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// filterOnelineGitLogToPaths
// ---------------------------------------------------------------------------

describe("filterOnelineGitLogToPaths", () => {
  test("drops commits that only touch local .omp files", () => {
    const gitLog = [
      "\u001e0123456789abcdef\u001ffeat(omp-audit): add /omp-audit command",
      ".omp/commands/omp-audit/index.ts",
      ".omp/omp-audit-config.json",
      "",
      "\u001eabcdef0123456789\u001ffix(review): guard agent-loader",
      "src/review/agent-loader.ts",
      "tests/review/agent-loader.test.ts",
      "",
      "\u001e1111111111111111\u001fdocs(readme): update install guide",
      "README.md",
      "",
    ].join("\n");

    expect(
      filterOnelineGitLogToPaths(gitLog, ["package.json", "src", "skills", "README.md"]),
    ).toBe([
      "abcdef0 fix(review): guard agent-loader",
      "1111111 docs(readme): update install guide",
    ].join("\n"));
  });

  test("keeps commits when any changed file is in the publish scope", () => {
    const gitLog = [
      "\u001eeeeeeeeeeeeeeeee\u001frefactor(release): tighten changelog scoping",
      ".omp/commands/omp-audit/index.ts",
      "src/commands/release.ts",
      "",
    ].join("\n");

    expect(filterOnelineGitLogToPaths(gitLog, ["src"]))
      .toBe("eeeeeee refactor(release): tighten changelog scoping");
  });
});


// ---------------------------------------------------------------------------
// buildChangelogMarkdown
// ---------------------------------------------------------------------------

describe("buildChangelogMarkdown", () => {
  const baseCommits: CategorizedCommits = {
    features: [{ hash: "abc1234", message: "add dark mode", scope: "ui" }],
    fixes: [{ hash: "def5678", message: "null pointer in parser" }],
    breaking: [],
    improvements: [],
    maintenance: [],
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
    expect(md).toContain("### \u{2728} Features");
    expect(md).toContain("- add dark mode (ui) `abc1234`");
  });

  test("fixes section has correct header and entry without scope", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.0.0");
    expect(md).toContain("### \u{1F41B} Fixes");
    expect(md).toContain("- null pointer in parser `def5678`");
  });

  test("empty sections are omitted", () => {
    const md = buildChangelogMarkdown(baseCommits, "1.0.0");
    expect(md).not.toContain("### \u{1F6A8} Breaking Changes");
    expect(md).not.toContain("### \u{1F4E6} Other");
    expect(md).not.toContain("### \u{1F527} Improvements");
    expect(md).not.toContain("Maintenance");
  });

  test("breaking section appears when present", () => {
    const commits: CategorizedCommits = {
      ...baseCommits,
      breaking: [{ hash: "bbb0002", message: "remove legacy API", scope: "core" }],
    };
    const md = buildChangelogMarkdown(commits, "2.0.0");
    expect(md).toContain("### \u{1F6A8} Breaking Changes");
    expect(md).toContain("- remove legacy API (core) `bbb0002`");
  });

  test("improvements section has correct header", () => {
    const commits: CategorizedCommits = {
      ...baseCommits,
      improvements: [{ hash: "rrr0001", message: "simplify loop", scope: "core" }],
    };
    const md = buildChangelogMarkdown(commits, "1.1.0");
    expect(md).toContain("### \u{1F527} Improvements");
    expect(md).toContain("- simplify loop (core) `rrr0001`");
  });

  test("maintenance section has correct header", () => {
    const commits: CategorizedCommits = {
      ...baseCommits,
      maintenance: [{ hash: "mmm0001", message: "update dependencies" }],
    };
    const md = buildChangelogMarkdown(commits, "1.0.1");
    expect(md).toContain("### \u{1F3D7}\uFE0F Maintenance");
    expect(md).toContain("- update dependencies `mmm0001`");
  });

  test("entry without scope omits parentheses", () => {
    const commits: CategorizedCommits = {
      ...emptyCommits(),
      features: [{ hash: "abc1234", message: "add feature" }],
    };
    const md = buildChangelogMarkdown(commits, "1.0.0");
    expect(md).toContain("- add feature `abc1234`");
    expect(md).not.toMatch(/- add feature \(\)/);
  });

  test("all sections empty still has header and date", () => {
    const md = buildChangelogMarkdown(emptyCommits(), "0.0.1");
    expect(md).toMatch(/^## v0\.0\.1/);
    expect(md).not.toContain("###");
  });

  test("sections appear in correct order", () => {
    const commits: CategorizedCommits = {
      features: [{ hash: "a", message: "feat" }],
      fixes: [{ hash: "b", message: "fix" }],
      breaking: [{ hash: "c", message: "break" }],
      improvements: [{ hash: "d", message: "improve" }],
      maintenance: [{ hash: "e", message: "maintain" }],
      other: [{ hash: "f", message: "other" }],
    };
    const md = buildChangelogMarkdown(commits, "1.0.0");
    const breakingIdx = md.indexOf("Breaking Changes");
    const featuresIdx = md.indexOf("Features");
    const fixesIdx = md.indexOf("Fixes");
    const improvementsIdx = md.indexOf("Improvements");
    const maintenanceIdx = md.indexOf("Maintenance");
    const otherIdx = md.indexOf("Other");
    expect(breakingIdx).toBeLessThan(featuresIdx);
    expect(featuresIdx).toBeLessThan(fixesIdx);
    expect(fixesIdx).toBeLessThan(improvementsIdx);
    expect(improvementsIdx).toBeLessThan(maintenanceIdx);
    expect(maintenanceIdx).toBeLessThan(otherIdx);
  });
});

// ---------------------------------------------------------------------------
// summarizeChanges
// ---------------------------------------------------------------------------

describe("summarizeChanges", () => {
  test("all empty returns 'no changes found'", () => {
    expect(summarizeChanges(emptyCommits())).toBe("no changes found");
  });

  test("single feature uses singular", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        features: [{ hash: "a", message: "x" }],
      })
    ).toBe("1 feature");
  });

  test("multiple features use plural", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        features: [
          { hash: "a", message: "x" },
          { hash: "b", message: "y" },
        ],
      })
    ).toBe("2 features");
  });

  test("single fix uses singular", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        fixes: [{ hash: "a", message: "x" }],
      })
    ).toBe("1 fix");
  });

  test("multiple fixes use plural", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        fixes: [
          { hash: "a", message: "x" },
          { hash: "b", message: "y" },
          { hash: "c", message: "z" },
        ],
      })
    ).toBe("3 fixes");
  });

  test("single improvement uses singular", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        improvements: [{ hash: "a", message: "x" }],
      })
    ).toBe("1 improvement");
  });

  test("multiple improvements use plural", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        improvements: [
          { hash: "a", message: "x" },
          { hash: "b", message: "y" },
        ],
      })
    ).toBe("2 improvements");
  });

  test("maintenance count in summary (always singular word)", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        maintenance: [{ hash: "a", message: "x" }, { hash: "b", message: "y" }],
      })
    ).toBe("2 maintenance");
  });

  test("single breaking change uses singular", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        breaking: [{ hash: "a", message: "x" }],
      })
    ).toBe("1 breaking change");
  });

  test("multiple breaking changes use plural", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        breaking: [{ hash: "a", message: "x" }, { hash: "b", message: "y" }],
      })
    ).toBe("2 breaking changes");
  });

  test("mixed: features, fixes, improvements, breaking", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        features: [{ hash: "a", message: "x" }, { hash: "b", message: "y" }, { hash: "c", message: "z" }],
        fixes: [{ hash: "d", message: "w" }, { hash: "e", message: "v" }],
        improvements: [{ hash: "g", message: "t" }],
        breaking: [{ hash: "f", message: "u" }],
      })
    ).toBe("3 features, 2 fixes, 1 improvement, 1 breaking change");
  });

  test("other and maintenance are not counted in summary", () => {
    const result = summarizeChanges({
      ...emptyCommits(),
      other: [{ hash: "a", message: "chore" }, { hash: "b", message: "docs" }],
    });
    expect(result).toBe("no changes found");
  });

  test("features and fixes but no breaking", () => {
    expect(
      summarizeChanges({
        ...emptyCommits(),
        features: [{ hash: "a", message: "x" }],
        fixes: [{ hash: "b", message: "y" }],
      })
    ).toBe("1 feature, 1 fix");
  });
});
