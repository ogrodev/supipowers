import * as path from "node:path";
import type { PlatformPaths } from "../../src/platform/types.js";
import { projectSlugFromRepoRoot } from "../../src/workspace/project-slug.js";
import { resolveRepoIdentityRootFromFs } from "../../src/workspace/repo-root.js";

/**
 * Build a hermetic {@link PlatformPaths} whose `global(...)` resolves under `tmpDir`,
 * not under the user's real `$HOME`. Use this in tests that exercise project-scoped
 * execution-state helpers (plans, reviews, reports, debug, visual, ui-design, …).
 */
export function createHermeticPaths(tmpDir: string): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) =>
      path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) =>
      path.join(tmpDir, "home", ".omp", "supipowers", ...segments),
    agent: (...segments: string[]) =>
      path.join(tmpDir, "home", ".omp", "agent", ...segments),
  };
}

/**
 * Compute the expected project-scoped state path for `cwd`, using the same slug
 * derivation the production code uses. Mirrors `getProjectStatePath(paths, cwd, …)`.
 */
export function expectedProjectStatePath(
  paths: PlatformPaths,
  cwd: string,
  ...segments: string[]
): string {
  const identityRoot = resolveRepoIdentityRootFromFs(cwd);
  const slug = projectSlugFromRepoRoot(identityRoot);
  return paths.global("projects", slug, ...segments);
}

/**
 * Resolve the slug for the repo identity root of `cwd`.
 */
export function slugForCwd(cwd: string): string {
  return projectSlugFromRepoRoot(resolveRepoIdentityRootFromFs(cwd));
}
