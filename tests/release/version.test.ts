import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  bumpVersion,
  findResumableLocalRelease,
  formatTag,
  getCurrentVersion,
  getLatestReleaseTag,
  getPublishedPackagePaths,
  getReleaseTagFormat,
  isTagOnRemote,
  isVersionReleased,
  suggestBump,
} from "../../src/release/version.js";
import type { CategorizedCommits, ReleaseTarget } from "../../src/types.js";

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
const fix = { hash: "def", message: "fix: something" };
const brk = { hash: "ghi", message: "feat!: breaking" };
const other = { hash: "jkl", message: "chore: cleanup" };

let tmpDir: string;

function writeManifest(relativePath: string, value: unknown): string {
  const manifestPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  return manifestPath;
}

function target(name: string, relativeDir = ".", version = "1.0.0"): ReleaseTarget {
  return {
    id: name,
    name,
    kind: relativeDir === "." ? "root" : "workspace",
    repoRoot: tmpDir,
    packageDir: relativeDir === "." ? tmpDir : path.join(tmpDir, relativeDir),
    manifestPath: relativeDir === "." ? path.join(tmpDir, "package.json") : path.join(tmpDir, relativeDir, "package.json"),
    relativeDir,
    version,
    private: false,
    publishScopePaths: relativeDir === "." ? ["package.json", "src"] : [`${relativeDir}/package.json`, `${relativeDir}/dist`],
    packageManager: "bun",
    defaultTagFormat: relativeDir === "." ? "v${version}" : `${name}@\${version}`,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ver-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

  test("pre-release suffix stripped before patch bump", () => {
    expect(bumpVersion("2.0.0-rc.1", "patch")).toBe("2.0.1");
  });

  test("output never carries a v-prefix", () => {
    expect(bumpVersion("1.0.0", "patch")).not.toMatch(/^v/);
  });
});

describe("target-aware version helpers", () => {
  test("reads version from the selected target manifest", () => {
    writeManifest("packages/pkg/package.json", { name: "@repo/pkg", version: "3.4.5" });

    expect(getCurrentVersion(target("@repo/pkg", "packages/pkg"))).toBe("3.4.5");
  });

  test("missing manifest returns 0.0.0", () => {
    expect(getCurrentVersion(target("@repo/pkg", "packages/pkg"))).toBe("0.0.0");
  });

  test("returns precomputed target publish scope paths", () => {
    expect(getPublishedPackagePaths(target("@repo/pkg", "packages/pkg"))).toEqual([
      "packages/pkg/package.json",
      "packages/pkg/dist",
    ]);
  });

  test("uses configured tag format for the root target", () => {
    expect(getReleaseTagFormat(target("root"), "release-${version}")).toBe("release-${version}");
  });

  test("uses the workspace default tag format for workspace targets", () => {
    expect(getReleaseTagFormat(target("@repo/pkg", "packages/pkg"), "v${version}")).toBe("@repo/pkg@${version}");
  });
});

describe("getLatestReleaseTag", () => {
  test("returns the newest root tag and preserves legacy root matching", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["tag", "--merged", "HEAD"]);
      return { stdout: "release-1.4.0\nv1.5.0\n@repo/pkg@9.9.9\n", stderr: "", code: 0 };
    };

    expect(await getLatestReleaseTag(exec as any, target("root"), "release-${version}")).toBe("v1.5.0");
  });

  test("ignores unrelated package tags for workspace targets", async () => {
    const exec = async () => ({
      stdout: "v9.9.9\n@repo/other@2.0.0\n@repo/pkg@1.4.0\n@repo/pkg@1.5.0\n",
      stderr: "",
      code: 0,
    });

    expect(await getLatestReleaseTag(exec as any, target("@repo/pkg", "packages/pkg"), "v${version}")).toBe("@repo/pkg@1.5.0");
  });
});

describe("isVersionReleased", () => {
  test("returns true when the current-format root tag exists", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["tag", "-l", "release-1.2.0", "v1.2.0"]);
      return { stdout: "release-1.2.0\n", stderr: "", code: 0 };
    };

    expect(await isVersionReleased(exec as any, target("root"), "1.2.0", "release-${version}")).toBe(true);
  });

  test("falls back to the legacy v-tag for the root target", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["tag", "-l", "release-1.2.0", "v1.2.0"]);
      return { stdout: "v1.2.0\n", stderr: "", code: 0 };
    };

    expect(await isVersionReleased(exec as any, target("root"), "1.2.0", "release-${version}")).toBe(true);
  });

  test("workspace targets do not fall back to legacy root tags", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["tag", "-l", "@repo/pkg@1.2.0"]);
      return { stdout: "", stderr: "", code: 0 };
    };

    expect(await isVersionReleased(exec as any, target("@repo/pkg", "packages/pkg"), "1.2.0", "v${version}")).toBe(false);
  });
});

describe("isTagOnRemote", () => {
  test("returns true when the current-format root tag exists on remote", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["ls-remote", "--tags", "origin", "release-1.2.0", "v1.2.0"]);
      return { stdout: "abc123\trefs/tags/release-1.2.0\n", stderr: "", code: 0 };
    };

    expect(await isTagOnRemote(exec as any, target("root"), "1.2.0", "release-${version}")).toBe(true);
  });

  test("workspace targets query only their package-specific tag", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["ls-remote", "--tags", "origin", "@repo/pkg@1.2.0"]);
      return { stdout: "abc123\trefs/tags/@repo/pkg@1.2.0\n", stderr: "", code: 0 };
    };

    expect(await isTagOnRemote(exec as any, target("@repo/pkg", "packages/pkg"), "1.2.0", "v${version}")).toBe(true);
  });
});

describe("findResumableLocalRelease", () => {
  test("returns a future local root tag that is on HEAD and missing from origin", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === "tag" && args[1] === "--merged") {
        return { stdout: "v1.4.0\nv1.5.0\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-remote") {
        expect(args).toEqual(["ls-remote", "--tags", "origin", "v1.5.0"]);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-list" || args[0] === "rev-parse") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };

    expect(await findResumableLocalRelease(exec as any, target("root"), "1.4.0", "v${version}")).toEqual({
      version: "1.5.0",
      tag: "v1.5.0",
    });
  });

  test("returns a future local workspace tag that is on HEAD and missing from origin", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args[0] === "tag" && args[1] === "--merged") {
        return { stdout: "@repo/pkg@1.4.0\n@repo/pkg@1.5.0\nv9.9.9\n", stderr: "", code: 0 };
      }
      if (args[0] === "ls-remote") {
        expect(args).toEqual(["ls-remote", "--tags", "origin", "@repo/pkg@1.5.0"]);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-list" || args[0] === "rev-parse") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };

    expect(await findResumableLocalRelease(exec as any, target("@repo/pkg", "packages/pkg"), "1.4.0", "v${version}")).toEqual({
      version: "1.5.0",
      tag: "@repo/pkg@1.5.0",
    });
  });
});

describe("formatTag", () => {
  test("standard v-prefix format", () => {
    expect(formatTag("1.5.0", "v${version}")).toBe("v1.5.0");
  });

  test("custom package tag format", () => {
    expect(formatTag("1.0.0", "@repo/pkg@${version}")).toBe("@repo/pkg@1.0.0");
  });

  test("supports prefix and suffix around the version placeholder", () => {
    expect(formatTag("1.0.0", "release-${version}-stable")).toBe("release-1.0.0-stable");
  });
});
