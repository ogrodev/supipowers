import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveUltraPlanRoot } from "../../../src/ultraplan/project-paths.js";
import { projectSlugFromRepoRoot } from "../../../src/ultraplan/runtime/project-slug.js";
import { resolveRepoIdentityRootFromFs } from "../../../src/workspace/repo-root.js";
import { createTestPaths, createTestRepo } from "../fixtures.js";

/**
 * Delta-spec Section 1 + Testing T1: prove that UltraPlan path resolution flows through a single
 * centralized entry point (`resolveUltraPlanRoot`) and that no code path outside
 * `src/ultraplan/project-paths.ts` constructs UltraPlan filesystem paths from literal path tokens.
 *
 * The AST scan is implemented as a source-text scan with comment/import stripping, because the
 * tokens of concern are literal string content — not syntactic shape. False positives (prose
 * messages) are filtered by requiring the literal to be the path itself, to contain the projects
 * scope marker, or to be a relative path ending in one of the forbidden filenames.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-ultraplan-resolve-root-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedPrimaryGitDir(repoRoot: string): void {
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
}

function createLinkedWorktree(repoRoot: string, worktreeName: string): { worktreeRoot: string; subdir: string } {
  seedPrimaryGitDir(repoRoot);
  const worktreeRoot = path.join(tmpDir, worktreeName);
  const subdir = path.join(worktreeRoot, "src", "features");
  const worktreeGitDir = path.join(repoRoot, ".git", "worktrees", worktreeName);
  fs.mkdirSync(subdir, { recursive: true });
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, "package.json"), JSON.stringify({ name: path.basename(repoRoot) }), "utf8");
  fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8");
  return { worktreeRoot, subdir };
}

describe("resolveUltraPlanRoot", () => {
  test("resolves to ${home}/.omp/supipowers/projects/<slug>/ultraplans for a cwd inside the repo", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir);
    const slug = projectSlugFromRepoRoot(repoRoot);
    const expected = paths.global("projects", slug, "ultraplans");

    expect(resolveUltraPlanRoot(paths, subdir)).toBe(expected);
    expect(resolveUltraPlanRoot(paths, repoRoot)).toBe(expected);
  });

  test("uses the primary checkout as the canonical identity for linked worktrees", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot, subdir } = createTestRepo(tmpDir, "primary-repo");
    const { worktreeRoot, subdir: worktreeSubdir } = createLinkedWorktree(repoRoot, "feature-worktree");
    const slug = projectSlugFromRepoRoot(repoRoot);
    const expected = paths.global("projects", slug, "ultraplans");

    expect(resolveRepoIdentityRootFromFs(subdir)).toBe(repoRoot);
    expect(resolveRepoIdentityRootFromFs(worktreeRoot)).toBe(repoRoot);
    expect(resolveRepoIdentityRootFromFs(worktreeSubdir)).toBe(repoRoot);
    expect(resolveUltraPlanRoot(paths, worktreeRoot)).toBe(expected);
    expect(resolveUltraPlanRoot(paths, worktreeSubdir)).toBe(expected);
  });

  test("uses the submodule checkout as its own repo identity", () => {
    const paths = createTestPaths(tmpDir);
    const superRoot = path.join(tmpDir, "super-repo");
    const submoduleRoot = path.join(superRoot, "vendor", "child-repo");
    const submoduleSubdir = path.join(submoduleRoot, "src");
    const submoduleGitDir = path.join(superRoot, ".git", "modules", "vendor", "child-repo");
    fs.mkdirSync(submoduleSubdir, { recursive: true });
    fs.mkdirSync(submoduleGitDir, { recursive: true });
    fs.writeFileSync(path.join(submoduleRoot, "package.json"), JSON.stringify({ name: "child-repo" }), "utf8");
    fs.writeFileSync(path.join(submoduleRoot, ".git"), `gitdir: ${submoduleGitDir}\n`, "utf8");
    const expected = paths.global("projects", projectSlugFromRepoRoot(submoduleRoot), "ultraplans");

    expect(resolveRepoIdentityRootFromFs(submoduleSubdir)).toBe(submoduleRoot);
    expect(resolveUltraPlanRoot(paths, submoduleSubdir)).toBe(expected);
  });

  test("keeps unrelated repositories distinct", () => {
    const paths = createTestPaths(tmpDir);
    const primary = createTestRepo(tmpDir, "primary-repo");
    const secondary = createTestRepo(tmpDir, "secondary-repo");
    seedPrimaryGitDir(primary.repoRoot);
    seedPrimaryGitDir(secondary.repoRoot);

    expect(resolveUltraPlanRoot(paths, primary.repoRoot)).not.toBe(
      resolveUltraPlanRoot(paths, secondary.repoRoot),
    );
  });

  test("fails closed when a linked worktree cannot prove its common repo identity", () => {
    const paths = createTestPaths(tmpDir);
    const { repoRoot } = createTestRepo(tmpDir, "primary-repo");
    seedPrimaryGitDir(repoRoot);
    const brokenWorktreeRoot = path.join(tmpDir, "broken-worktree");
    fs.mkdirSync(brokenWorktreeRoot, { recursive: true });
    fs.writeFileSync(path.join(brokenWorktreeRoot, "package.json"), JSON.stringify({ name: "primary-repo" }), "utf8");
    fs.writeFileSync(
      path.join(brokenWorktreeRoot, ".git"),
      `gitdir: ${path.join(repoRoot, ".git", "worktrees", "missing-worktree")}\n`,
      "utf8",
    );

    expect(() => resolveRepoIdentityRootFromFs(brokenWorktreeRoot)).toThrow();
    expect(() => resolveUltraPlanRoot(paths, brokenWorktreeRoot)).toThrow();
  });
});

describe("UltraPlan path centralization scan", () => {
  // Any of these as a whole-path literal must live only inside src/ultraplan/project-paths.ts.
  const FORBIDDEN_FILENAMES = [
    "manifest.json",
    "authored.json",
    "runtime-tracker.json",
    "hooks-log.jsonl",
    "migration.json",
  ] as const;

  const FORBIDDEN_EXACT = [
    "ultraplans",
    ...FORBIDDEN_FILENAMES,
  ] as const;

  const FORBIDDEN_SUBSTRINGS = [
    ".omp/supipowers/projects",
    "/ultraplans/",
  ] as const;

  const repoRoot = process.cwd();
  const CENTRALIZED_FILE = path.join(repoRoot, "src", "ultraplan", "project-paths.ts");

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile() && abs.endsWith(".ts") && !abs.endsWith(".d.ts")) {
          out.push(abs);
        }
      }
    }
    return out;
  }

  function targetFiles(): string[] {
    return [
      ...walk(path.join(repoRoot, "src", "ultraplan")),
      path.join(repoRoot, "src", "commands", "ultraplan.ts"),
      path.join(repoRoot, "src", "context-mode", "hooks.ts"),
    ].filter((file) => fs.existsSync(file));
  }

  function stripCommentsAndImports(source: string): string {
    // Strip block comments /* ... */
    let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
    // Strip line comments // ...
    cleaned = cleaned
      .split("\n")
      .map((line) => {
        // Preserve // that appears inside a string literal by doing a crude quote-aware split.
        let inDouble = false;
        let inSingle = false;
        let inBacktick = false;
        let out = "";
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          const prev = line[i - 1];
          if (!inSingle && !inBacktick && c === '"' && prev !== "\\") inDouble = !inDouble;
          else if (!inDouble && !inBacktick && c === "'" && prev !== "\\") inSingle = !inSingle;
          else if (!inDouble && !inSingle && c === "`" && prev !== "\\") inBacktick = !inBacktick;
          if (!inDouble && !inSingle && !inBacktick && c === "/" && line[i + 1] === "/") {
            break;
          }
          out += c;
        }
        return out;
      })
      .join("\n");
    // Strip `import ... from "...";` and `export ... from "...";`
    cleaned = cleaned.replace(/^\s*import[\s\S]*?;\s*$/gm, "");
    cleaned = cleaned.replace(/^\s*export\s*\{[^}]*\}\s*from\s+["'][^"']*["']\s*;?\s*$/gm, "");
    return cleaned;
  }

  function findStringLiterals(source: string): string[] {
    const literals: string[] = [];
    const doubleQuoted = /"((?:[^"\\\n]|\\.)*)"/g;
    const singleQuoted = /'((?:[^'\\\n]|\\.)*)'/g;
    const rawTemplate = /`([^`$\\]*)`/g;
    for (const pat of [doubleQuoted, singleQuoted, rawTemplate]) {
      for (const m of source.matchAll(pat)) {
        literals.push(m[1]);
      }
    }
    return literals;
  }

  function isPathConstruction(literal: string): boolean {
    if ((FORBIDDEN_EXACT as readonly string[]).includes(literal)) return true;
    for (const sub of FORBIDDEN_SUBSTRINGS) {
      if (literal.includes(sub)) return true;
    }
    for (const filename of FORBIDDEN_FILENAMES) {
      if (literal.endsWith("/" + filename) || literal.endsWith("\\" + filename)) return true;
    }
    if (literal.endsWith("/ultraplans") || literal.endsWith("\\ultraplans")) return true;
    return false;
  }

  test("no module outside src/ultraplan/project-paths.ts uses forbidden UltraPlan path literals", () => {
    const offenders: string[] = [];

    for (const file of targetFiles()) {
      if (path.resolve(file) === path.resolve(CENTRALIZED_FILE)) continue;

      const source = fs.readFileSync(file, "utf8");
      const stripped = stripCommentsAndImports(source);
      const literals = findStringLiterals(stripped);
      const seen = new Set<string>();
      for (const literal of literals) {
        if (seen.has(literal)) continue;
        seen.add(literal);
        if (isPathConstruction(literal)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${JSON.stringify(literal)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
