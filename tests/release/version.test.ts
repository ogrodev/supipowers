import fs from "fs";
import os from "os";
import path from "path";
import { suggestBump, bumpVersion, getCurrentVersion, isVersionReleased } from "../../src/release/version.js";
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
// isVersionReleased
// ---------------------------------------------------------------------------

describe("isVersionReleased", () => {
  function mockExec(stdout: string, code = 0) {
    return async () => ({ stdout, stderr: "", code });
  }

  test("returns true when tag exists", async () => {
    const exec = mockExec("v1.2.0\n");
    expect(await isVersionReleased(exec, "/tmp", "1.2.0")).toBe(true);
  });

  test("returns false when tag does not exist", async () => {
    const exec = mockExec("");
    expect(await isVersionReleased(exec, "/tmp", "1.2.0")).toBe(false);
  });

  test("returns false when git command fails", async () => {
    const exec = mockExec("", 128);
    expect(await isVersionReleased(exec, "/tmp", "1.2.0")).toBe(false);
  });

  test("handles version already prefixed with v", async () => {
    const exec = mockExec("v2.0.0\n");
    expect(await isVersionReleased(exec, "/tmp", "v2.0.0")).toBe(true);
  });

  test("returns false when exec throws", async () => {
    const exec = async () => { throw new Error("git not found"); };
    expect(await isVersionReleased(exec, "/tmp", "1.0.0")).toBe(false);
  });
});