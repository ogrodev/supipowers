/**
 * DISCOVER stage runner.
 *
 * Builds `<session>/discover.json` deterministically from the filesystem:
 *  - language detection by file extension (deterministic, fast),
 *  - cross-checks against `src/deps/registry.ts` for installed tooling,
 *  - LSP availability via `platform.getActiveTools()`,
 *  - existing supipowers + MCP infra scan,
 *  - existing anti-slop tooling scan (fallow / desloppify / knip / jscpd / dependency-cruiser),
 *  - language-coverage map and recommended backend.
 *
 * Discover is **deterministic by design** — no agent session is spawned. The plan calls
 * for a user gate (planning_ask) after Discover, which is owned by the command handler,
 * not the stage runner.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { HarnessDiscoverArtifact } from "../../types.js";
import { recommendBackend } from "../anti_slop/recommend.js";
import {
  type HarnessStageRunResult,
  type HarnessStageRunner,
  type HarnessStageRunnerContext,
  nowIso,
} from "../stage-runner.js";
import { saveHarnessDiscover } from "../storage.js";
import { loadHarnessDiscover } from "../storage.js";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  ".bun",
]);

interface FileScanResult {
  files: number;
  byLanguage: Map<string, number>;
}

function scanRepoLanguages(cwd: string, depthLimit = 6, fileLimit = 5000): FileScanResult {
  let files = 0;
  const byLanguage = new Map<string, number>();

  function walk(dir: string, depth: number): void {
    if (depth > depthLimit || files > fileLimit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files > fileLimit) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== ".github") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      const ext = path.extname(entry.name).toLowerCase();
      const lang = LANGUAGE_BY_EXT[ext];
      if (lang) byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + 1);
    }
  }

  walk(cwd, 0);
  return { files, byLanguage };
}

function existsSync(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function detectMonorepoShape(cwd: string): HarnessDiscoverArtifact["monorepoShape"] {
  // Heuristics: presence of package workspace declarations, pnpm-workspace.yaml, lerna.json,
  // turbo.json, multiple top-level package.json files.
  if (existsSync(path.join(cwd, "pnpm-workspace.yaml"))) return "monorepo";
  if (existsSync(path.join(cwd, "lerna.json"))) return "monorepo";
  if (existsSync(path.join(cwd, "turbo.json"))) return "monorepo";
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    const cargoToml = (() => {
      try {
        return fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf8");
      } catch {
        return "";
      }
    })();
    if (/\[workspace\]/.test(cargoToml)) return "monorepo";
  }
  // packages/ or apps/ + multiple package.json
  const packagesDir = path.join(cwd, "packages");
  const appsDir = path.join(cwd, "apps");
  if (existsSync(packagesDir) || existsSync(appsDir)) return "monorepo";
  return "single-package";
}

function detectCi(cwd: string): HarnessDiscoverArtifact["ci"] {
  const ghDir = path.join(cwd, ".github", "workflows");
  if (existsSync(ghDir)) {
    const files: string[] = [];
    try {
      for (const entry of fs.readdirSync(ghDir)) {
        if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
          files.push(`.github/workflows/${entry}`);
        }
      }
    } catch {
      // ignore
    }
    if (files.length > 0) return { detected: true, provider: "github-actions", configFiles: files };
  }
  if (existsSync(path.join(cwd, ".gitlab-ci.yml"))) {
    return { detected: true, provider: "gitlab-ci", configFiles: [".gitlab-ci.yml"] };
  }
  if (existsSync(path.join(cwd, ".circleci", "config.yml"))) {
    return { detected: true, provider: "circle-ci", configFiles: [".circleci/config.yml"] };
  }
  return { detected: false, configFiles: [] };
}

function detectCommitConventions(cwd: string): HarnessDiscoverArtifact["commitConventions"] {
  if (existsSync(path.join(cwd, "commitlint.config.js")) || existsSync(path.join(cwd, "commitlint.config.cjs"))) {
    return { detected: true, style: "conventional" };
  }
  if (existsSync(path.join(cwd, ".commitlintrc.json")) || existsSync(path.join(cwd, ".commitlintrc"))) {
    return { detected: true, style: "conventional" };
  }
  return { detected: false };
}

function detectExistingAntiSlop(cwd: string): HarnessDiscoverArtifact["antiSlopExisting"] {
  const exists = (rel: string) => (existsSync(path.join(cwd, rel)) ? rel : null);
  return {
    fallowConfig: exists(".fallowrc.json") ?? exists(".fallow.toml"),
    desloppifyConfig: exists(".desloppify") ?? exists(".desloppifyrc"),
    knipConfig: exists("knip.json") ?? exists(".knip.json"),
    jscpdConfig: exists(".jscpd.json") ?? exists("jscpd.json"),
    dependencyCruiserConfig: exists(".dependency-cruiser.cjs") ?? exists(".dependency-cruiser.json"),
    eslintConfig:
      exists("eslint.config.js") ??
      exists("eslint.config.cjs") ??
      exists("eslint.config.mjs") ??
      exists(".eslintrc") ??
      exists(".eslintrc.json") ??
      exists(".eslintrc.cjs"),
    biomeConfig: exists("biome.json") ?? exists("biome.jsonc") ?? exists(".biomerc.json"),
  };
}

function detectOmpInfra(cwd: string): HarnessDiscoverArtifact["ompInfra"] {
  const supipowersDir = path.join(cwd, ".omp", "supipowers");
  const hasSupipowers = existsSync(supipowersDir);
  const skills: string[] = [];
  const reviewAgents: string[] = [];
  const mcpServers: string[] = [];
  let plansCount = 0;

  // Skills are typically in skills/ at the repo root.
  const skillsDir = path.join(cwd, "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.push(entry.name);
      }
    } catch {
      // ignore
    }
  }

  if (hasSupipowers) {
    const reviewAgentsDir = path.join(supipowersDir, "review-agents");
    if (existsSync(reviewAgentsDir)) {
      try {
        for (const entry of fs.readdirSync(reviewAgentsDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            reviewAgents.push(entry.name.replace(/\.md$/, ""));
          }
        }
      } catch {
        // ignore
      }
    }
    const plansDir = path.join(supipowersDir, "plans");
    if (existsSync(plansDir)) {
      try {
        plansCount = fs.readdirSync(plansDir).filter((f) => f.endsWith(".md")).length;
      } catch {
        plansCount = 0;
      }
    }
    const mcpJson = path.join(supipowersDir, ".mcp.json");
    if (existsSync(mcpJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(mcpJson, "utf8")) as {
          servers?: Record<string, unknown>;
        };
        if (parsed.servers) mcpServers.push(...Object.keys(parsed.servers));
      } catch {
        // ignore
      }
    }
  }

  return { hasSupipowers, skills, reviewAgents, mcpServers, plansCount };
}

function detectFrameworks(cwd: string): string[] {
  const frameworks: string[] = [];
  const pkgJsonPath = path.join(cwd, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("react" in all) frameworks.push("react");
      if ("next" in all) frameworks.push("next");
      if ("vue" in all) frameworks.push("vue");
      if ("svelte" in all) frameworks.push("svelte");
      if ("@nestjs/core" in all) frameworks.push("nestjs");
      if ("express" in all) frameworks.push("express");
      if ("fastify" in all) frameworks.push("fastify");
      if ("hono" in all) frameworks.push("hono");
    } catch {
      // ignore malformed package.json
    }
  }
  if (existsSync(path.join(cwd, "Cargo.toml"))) frameworks.push("cargo");
  if (existsSync(path.join(cwd, "pyproject.toml"))) frameworks.push("python-project");
  if (existsSync(path.join(cwd, "go.mod"))) frameworks.push("go-modules");
  return frameworks;
}

function detectPackageManagers(cwd: string): string[] {
  const out: string[] = [];
  if (existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))) out.push("bun");
  if (existsSync(path.join(cwd, "package-lock.json"))) out.push("npm");
  if (existsSync(path.join(cwd, "yarn.lock"))) out.push("yarn");
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) out.push("pnpm");
  if (existsSync(path.join(cwd, "Cargo.lock"))) out.push("cargo");
  if (existsSync(path.join(cwd, "poetry.lock"))) out.push("poetry");
  if (existsSync(path.join(cwd, "uv.lock"))) out.push("uv");
  if (existsSync(path.join(cwd, "go.sum"))) out.push("go-modules");
  return out;
}

function detectBuildTools(cwd: string): string[] {
  const out: string[] = [];
  if (existsSync(path.join(cwd, "tsconfig.json"))) out.push("tsc");
  if (existsSync(path.join(cwd, "vite.config.ts")) || existsSync(path.join(cwd, "vite.config.js"))) out.push("vite");
  if (existsSync(path.join(cwd, "webpack.config.js"))) out.push("webpack");
  if (existsSync(path.join(cwd, "esbuild.config.js"))) out.push("esbuild");
  if (existsSync(path.join(cwd, "Makefile"))) out.push("make");
  if (existsSync(path.join(cwd, "Cargo.toml"))) out.push("cargo");
  return out;
}

function detectTestTools(cwd: string): string[] {
  const out: string[] = [];
  const pkgJsonPath = path.join(cwd, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("vitest" in deps) out.push("vitest");
      if ("jest" in deps) out.push("jest");
      if ("@playwright/test" in deps) out.push("playwright");
      if ("cypress" in deps) out.push("cypress");
      if (pkg.scripts?.test?.includes("bun test") || pkg.scripts?.test?.includes("bun:test")) out.push("bun:test");
    } catch {
      // ignore
    }
  }
  if (existsSync(path.join(cwd, "pytest.ini")) || existsSync(path.join(cwd, "pyproject.toml"))) {
    try {
      const pyproject = existsSync(path.join(cwd, "pyproject.toml"))
        ? fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8")
        : "";
      if (pyproject.includes("pytest")) out.push("pytest");
    } catch {
      // ignore
    }
  }
  if (existsSync(path.join(cwd, "Cargo.toml"))) out.push("cargo-test");
  if (existsSync(path.join(cwd, "go.mod"))) out.push("go-test");
  return out;
}

function detectLintTools(cwd: string): string[] {
  const out: string[] = [];
  if (existsSync(path.join(cwd, "eslint.config.js")) || existsSync(path.join(cwd, "eslint.config.cjs")) || existsSync(path.join(cwd, ".eslintrc.json"))) {
    out.push("eslint");
  }
  if (existsSync(path.join(cwd, "biome.json")) || existsSync(path.join(cwd, "biome.jsonc"))) out.push("biome");
  if (existsSync(path.join(cwd, ".prettierrc"))) out.push("prettier");
  if (existsSync(path.join(cwd, "ruff.toml"))) out.push("ruff");
  if (existsSync(path.join(cwd, "rustfmt.toml")) || existsSync(path.join(cwd, ".rustfmt.toml"))) out.push("rustfmt");
  return out;
}

/**
 * Build the discover artifact from the filesystem alone. Pure function for testability:
 * the same inputs produce the same outputs (timestamp injected via `now`).
 */
export function buildDiscoverArtifact(input: {
  cwd: string;
  sessionId: string;
  now: string;
}): HarnessDiscoverArtifact {
  const scan = scanRepoLanguages(input.cwd);
  const totalLanguageFiles = [...scan.byLanguage.values()].reduce((sum, n) => sum + n, 0);
  const languageCoverage = [...scan.byLanguage.entries()]
    .map(([language, fileCount]) => ({
      language,
      fileCount,
      share: totalLanguageFiles === 0 ? 0 : fileCount / totalLanguageFiles,
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  const languages = languageCoverage.map((c) => c.language);
  const recommendation = recommendBackend({ languageCoverage });

  // Detect duplicates between existing tools and the harness's recommended backend.
  const antiSlopExisting = detectExistingAntiSlop(input.cwd);
  const ompInfra = detectOmpInfra(input.cwd);
  const duplicates: HarnessDiscoverArtifact["duplicates"] = [];
  if (antiSlopExisting.fallowConfig && recommendation.backend !== "fallow" && recommendation.backend !== "hybrid") {
    duplicates.push({
      area: "anti-slop",
      existing: antiSlopExisting.fallowConfig,
      conflict: `recommended backend is ${recommendation.backend}; existing fallow config will be unused unless user overrides`,
    });
  }
  if (antiSlopExisting.desloppifyConfig && recommendation.backend !== "desloppify" && recommendation.backend !== "hybrid") {
    duplicates.push({
      area: "anti-slop",
      existing: antiSlopExisting.desloppifyConfig,
      conflict: `recommended backend is ${recommendation.backend}; existing desloppify config will be unused unless user overrides`,
    });
  }

  return {
    sessionId: input.sessionId,
    recordedAt: input.now,
    languages,
    frameworks: detectFrameworks(input.cwd),
    packageManagers: detectPackageManagers(input.cwd),
    buildTools: detectBuildTools(input.cwd),
    testTools: detectTestTools(input.cwd),
    lintTools: detectLintTools(input.cwd),
    monorepoShape: detectMonorepoShape(input.cwd),
    ci: detectCi(input.cwd),
    ompInfra,
    antiSlopExisting,
    languageCoverage,
    recommendedBackend: recommendation.backend,
    recommendedBackendReason: recommendation.reason,
    commitConventions: detectCommitConventions(input.cwd),
    duplicates,
    notes: [],
  };
}

export class HarnessDiscoverStage implements HarnessStageRunner {
  readonly stage = "discover" as const;

  async isReady(_ctx: HarnessStageRunnerContext): Promise<boolean> {
    // Discover only needs a readable cwd.
    return true;
  }

  async isComplete(ctx: HarnessStageRunnerContext): Promise<boolean> {
    const loaded = loadHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId);
    return loaded.ok;
  }

  async run(ctx: HarnessStageRunnerContext): Promise<HarnessStageRunResult> {
    if (await this.isComplete(ctx)) {
      return {
        status: "skipped",
        stage: this.stage,
        artifactPaths: ["discover.json"],
        details: { reason: "discover artifact already exists" },
      };
    }

    const artifact = buildDiscoverArtifact({
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      now: nowIso(ctx),
    });
    const persisted = saveHarnessDiscover(ctx.paths, ctx.cwd, ctx.sessionId, artifact);
    if (!persisted.ok) {
      return {
        status: "failed",
        stage: this.stage,
        artifactPaths: [],
        error: `failed to persist discover artifact: ${persisted.error.message}`,
      };
    }
    return {
      status: "completed",
      stage: this.stage,
      artifactPaths: ["discover.json"],
      details: {
        languages: artifact.languages,
        recommendedBackend: artifact.recommendedBackend,
      },
    };
  }
}
