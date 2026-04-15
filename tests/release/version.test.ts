import fs from "fs";
import os from "os";
import path from "path";
import {
  suggestBump,
  bumpVersion,
  getCurrentVersion,
  getPublishedPackagePaths,
  isVersionReleased,
  isTagOnRemote,
  findResumableLocalRelease,
  formatTag,
} from "../../src/release/version.js";
import type { CategorizedCommits } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommits(overrides: Partial<CategorizedCommits> = {}): CategorizedCommits {
  return {
    features: [],
    fixes: [],
    breaking: [],
    improvements: [],
    maintenance: [],
    other: [],
    ...overrides,
  };
}

const feat = { hash: "abc", message: "feat: something" };
const fix  = { hash: "def", message: "fix: something" };
const brk  = { hash: "ghi", message: "feat!: breaking" };
const other = { hash: "jkl", message: "chore: cleanup" };

// ---------------------------------------------------------------------------
// suggestBump
// ---------------------------------------------------------------------------

describe("suggestBump", () => {
  test("breaking commits → major", () => {
    expect(suggestBump(makeCommits({ breaking: [brk] }))).toBe("major");
  });

  test("feature commits only → minor", () => {
    expect(suggestBump(makeCommits({ features: [feat] }))).toBe("minor");
  });

  test("fix commits only → patch", () => {
    expect(suggestBump(makeCommits({ fixes: [fix] }))).toBe("patch");
  });

  test("breaking wins over features (mixed)", () => {
    expect(suggestBump(makeCommits({ breaking: [brk], features: [feat] }))).toBe("major");
  });

  test("all empty → patch", () => {
    expect(suggestBump(makeCommits())).toBe("patch");
  });

  test("other commits only → patch", () => {
    expect(suggestBump(makeCommits({ other: [other] }))).toBe("patch");
  });
});

// ---------------------------------------------------------------------------
// bumpVersion
// ---------------------------------------------------------------------------

describe("bumpVersion", () => {
  test("minor bump resets patch: 1.2.3 → 1.3.0", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  test("major bump resets minor+patch: 1.2.3 → 2.0.0", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  test("patch bump increments patch: 1.2.3 → 1.2.4", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  test("minor bump from zero minor: 0.1.0 → 0.2.0", () => {
    expect(bumpVersion("0.1.0", "minor")).toBe("0.2.0");
  });

  test("pre-release suffix stripped before bump: 1.2.3-beta.1 major → 2.0.0", () => {
    expect(bumpVersion("1.2.3-beta.1", "major")).toBe("2.0.0");
  });

  test("pre-release suffix stripped before minor bump: 1.2.3-alpha.0 → 1.3.0", () => {
    expect(bumpVersion("1.2.3-alpha.0", "minor")).toBe("1.3.0");
  });

  test("pre-release suffix stripped before patch bump: 2.0.0-rc.1 → 2.0.1", () => {
    expect(bumpVersion("2.0.0-rc.1", "patch")).toBe("2.0.1");
  });

  test("output never carries a v-prefix", () => {
    expect(bumpVersion("1.0.0", "patch")).not.toMatch(/^v/);
  });
});

// ---------------------------------------------------------------------------
// getCurrentVersion
// ---------------------------------------------------------------------------

describe("getCurrentVersion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ver-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads version from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-pkg", version: "3.4.5" }),
    );
    expect(getCurrentVersion(tmpDir)).toBe("3.4.5");
  });

  test("missing file returns 0.0.0", () => {
    expect(getCurrentVersion(tmpDir)).toBe("0.0.0");
  });

  test("package.json without version field returns 0.0.0", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "no-version" }),
    );
    expect(getCurrentVersion(tmpDir)).toBe("0.0.0");
  });

  test("malformed JSON returns 0.0.0", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{ invalid json }");
    expect(getCurrentVersion(tmpDir)).toBe("0.0.0");
  });
});


// ---------------------------------------------------------------------------
// getPublishedPackagePaths
// ---------------------------------------------------------------------------

describe("getPublishedPackagePaths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-publish-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns package.json plus normalized files whitelist entries", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test-pkg",
        files: ["src", "./skills/", "README.md", "src"],
      }),
    );

    expect(getPublishedPackagePaths(tmpDir)).toEqual([
      "package.json",
      "src",
      "skills",
      "README.md",
    ]);
  });

  test("returns null when files whitelist is absent", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-pkg", version: "1.0.0" }),
    );

    expect(getPublishedPackagePaths(tmpDir)).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// isVersionReleased
// ---------------------------------------------------------------------------

describe("isVersionReleased", () => {
  function mockExec(stdout: string, code = 0) {
    return async () => ({ stdout, stderr: "", code });
  }

  test("returns true when the current-format tag exists", async () => {
    const exec = mockExec("v1.2.0\n");
    expect(await isVersionReleased(exec, "/tmp", "1.2.0", "v${version}")).toBe(true);
  });

  test("falls back to the legacy v-tag when the configured format changed", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["tag", "-l", "release-1.2.0", "v1.2.0"]);
      return { stdout: "v1.2.0\n", stderr: "", code: 0 };
    };

    expect(await isVersionReleased(exec, "/tmp", "1.2.0", "release-${version}")).toBe(true);
  });

  test("returns false when neither current nor legacy tag exists", async () => {
    const exec = mockExec("");
    expect(await isVersionReleased(exec, "/tmp", "1.2.0", "release-${version}")).toBe(false);
  });

  test("returns false when git command fails", async () => {
    const exec = mockExec("", 128);
    expect(await isVersionReleased(exec, "/tmp", "1.2.0", "v${version}")).toBe(false);
  });

  test("version param is always bare (no v-prefix) in practice", async () => {
    const exec = mockExec("v2.0.0\n");
    expect(await isVersionReleased(exec, "/tmp", "2.0.0", "v${version}")).toBe(true);
  });

  test("returns false when exec throws", async () => {
    const exec = async () => { throw new Error("git not found"); };
    expect(await isVersionReleased(exec, "/tmp", "1.0.0", "v${version}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTagOnRemote
// ---------------------------------------------------------------------------

describe("isTagOnRemote", () => {
  function mockExec(stdout: string, code = 0) {
    return async () => ({ stdout, stderr: "", code });
  }

  test("returns true when the current-format tag exists on remote", async () => {
    const exec = mockExec("abc123\trefs/tags/v1.2.0\n");
    expect(await isTagOnRemote(exec, "/tmp", "1.2.0", "v${version}")).toBe(true);
  });

  test("falls back to the legacy v-tag on remote when the configured format changed", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["ls-remote", "--tags", "origin", "release-1.2.0", "v1.2.0"]);
      return { stdout: "abc123\trefs/tags/v1.2.0\n", stderr: "", code: 0 };
    };

    expect(await isTagOnRemote(exec, "/tmp", "1.2.0", "release-${version}")).toBe(true);
  });

  test("returns false when no matching tag exists on remote", async () => {
    const exec = mockExec("");
    expect(await isTagOnRemote(exec, "/tmp", "1.2.0", "release-${version}")).toBe(false);
  });

  test("returns false when git command fails", async () => {
    const exec = mockExec("", 128);
    expect(await isTagOnRemote(exec, "/tmp", "1.2.0", "v${version}")).toBe(false);
  });

  test("version param is always bare (no v-prefix) in practice", async () => {
    // getCurrentVersion() never returns v-prefixed versions.
    // formatTag handles the prefix via tagFormat, so passing "1.2.0" is correct.
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["ls-remote", "--tags", "origin", "v1.2.0"]);
      return { stdout: "abc123\trefs/tags/v1.2.0\n", stderr: "", code: 0 };
    };
    expect(await isTagOnRemote(exec, "/tmp", "1.2.0", "v${version}")).toBe(true);
  });

  test("returns false when exec throws", async () => {
    const exec = async () => { throw new Error("network error"); };
    expect(await isTagOnRemote(exec, "/tmp", "1.0.0", "v${version}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findResumableLocalRelease
// ---------------------------------------------------------------------------

describe("findResumableLocalRelease", () => {
  test("returns a future local tag that is on HEAD and missing from origin", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === "tag" && args[1] === "--merged") {
        return { stdout: "v1.4.0\nv1.5.0\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-remote") {
        expect(args).toEqual(["ls-remote", "--tags", "origin", "v1.5.0"]);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-list") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };

    expect(await findResumableLocalRelease(exec as any, "/tmp", "1.4.0", "v${version}")).toEqual({
      version: "1.5.0",
      tag: "v1.5.0",
    });
  });

  test("returns null when the future local tag is not on HEAD", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === "tag" && args[1] === "--merged") {
        return { stdout: "v1.4.0\nv1.5.0\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-remote") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-list") {
        return { stdout: "oldtag\n", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: "headsha\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };

    expect(await findResumableLocalRelease(exec as any, "/tmp", "1.4.0", "v${version}")).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// formatTag
// ---------------------------------------------------------------------------

describe("formatTag", () => {
  test("standard v-prefix format", () => {
    expect(formatTag("1.5.0", "v${version}")).toBe("v1.5.0");
  });

  test("pre-release version with v-prefix", () => {
    expect(formatTag("2.0.0-beta.1", "v${version}")).toBe("v2.0.0-beta.1");
  });

  test("no prefix when format is just the placeholder", () => {
    expect(formatTag("1.0.0", "${version}")).toBe("1.0.0");
  });

  test("custom prefix", () => {
    expect(formatTag("1.0.0", "release-${version}")).toBe("release-1.0.0");
  });

  test("supports prefix and suffix around the version placeholder", () => {
    expect(formatTag("1.0.0", "release-${version}-stable")).toBe("release-1.0.0-stable");
  });
});