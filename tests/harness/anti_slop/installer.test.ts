import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  buildFallowConfig,
  ensureDesloppifyGitignore,
  installAntiSlopBackend,
  installFallow,
} from "../../../src/harness/anti_slop/installer.js";
import { createTestPaths, createTestRepo } from "../../ultraplan/fixtures.js";

let tmpDir: string;
let cwd: string;
let paths: ReturnType<typeof createTestPaths>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-harness-installer-"));
  paths = createTestPaths(tmpDir);
  cwd = createTestRepo(tmpDir).repoRoot;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildFallowConfig", () => {
  test("emits architecture rules from layer input", () => {
    const config = buildFallowConfig({
      layerRules: [
        {
          layer: "domain",
          globs: ["src/domain/**"],
          allowedImports: ["domain"],
          forbiddenImports: ["infra"],
        },
      ],
      entryPoints: ["src/index.ts"],
    });
    expect(config.architecture).toEqual([
      {
        layer: "domain",
        files: ["src/domain/**"],
        allowed: ["domain"],
        forbidden: ["infra"],
      },
    ]);
    expect(config.entryPoints).toEqual(["src/index.ts"]);
  });
});

describe("installFallow", () => {
  test("writes .fallowrc.json when apply: true", async () => {
    const result = await installFallow(paths, {
      cwd,
      backend: "fallow",
      layerRules: [],
      skillTargets: [],
      entryPoints: [],
      apply: true,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(true);
  });

  test("dry-run does not write", async () => {
    const result = await installFallow(paths, {
      cwd,
      backend: "fallow",
      layerRules: [],
      skillTargets: [],
      entryPoints: [],
      apply: false,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(false);
  });

  test("idempotent: writing the same content twice doesn't churn", async () => {
    await installFallow(paths, { cwd, backend: "fallow", layerRules: [], skillTargets: [], entryPoints: [], apply: true });
    const second = await installFallow(paths, {
      cwd,
      backend: "fallow",
      layerRules: [],
      skillTargets: [],
      entryPoints: [],
      apply: true,
    });
    expect(second.actions[0]).toContain("already up-to-date");
  });
});

describe("ensureDesloppifyGitignore", () => {
  test("appends to .gitignore when missing", async () => {
    const gitignorePath = path.join(cwd, ".gitignore");
    fs.writeFileSync(gitignorePath, "node_modules\n");
    const result = await ensureDesloppifyGitignore({ cwd, apply: true });
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(gitignorePath, "utf8");
    expect(content).toContain(".desloppify/");
  });

  test("no-op when entry already present", async () => {
    const gitignorePath = path.join(cwd, ".gitignore");
    fs.writeFileSync(gitignorePath, ".desloppify/\n");
    const result = await ensureDesloppifyGitignore({ cwd, apply: true });
    expect(result.actions[0]).toContain("already contains");
  });
});

describe("installAntiSlopBackend dispatch", () => {
  test("supi-native backend installs nothing", async () => {
    const platform = { paths, exec: mock() } as any;
    const result = await installAntiSlopBackend(platform, paths, {
      cwd,
      backend: "supi-native",
      layerRules: [],
      skillTargets: [],
      entryPoints: [],
      apply: true,
    });
    expect(result.ok).toBe(true);
    expect(result.actions[0]).toContain("supi-native");
  });

  test("hybrid backend installs both fallow + desloppify", async () => {
    const platform = {
      paths,
      exec: mock(async () => ({ stdout: "", stderr: "", code: 0 })),
    } as any;
    const result = await installAntiSlopBackend(platform, paths, {
      cwd,
      backend: "hybrid",
      layerRules: [],
      skillTargets: [],
      entryPoints: [],
      apply: true,
    });
    expect(fs.existsSync(path.join(cwd, ".fallowrc.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".gitignore"))).toBe(true);
    expect(result.ok).toBe(true);
  });
});
