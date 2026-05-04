import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmDirWithRetry } from "../helpers/fs.js";
import { buildRepoMap } from "../../src/context-mode/repomap.js";

function makePlatform(rootDir: string) {
  return {
    name: "omp" as const,
    paths: { dotDir: ".omp", dotDirDisplay: ".omp", project: () => rootDir, global: () => rootDir, agent: () => rootDir },
    capabilities: {
      agentSessions: false,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
      activeToolFiltering: false,
    },
    registerCommand: () => {},
    getCommands: () => [],
    on: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 1 }),
    sendMessage: () => {},
    sendUserMessage: () => {},
    getActiveTools: () => [],
    registerMessageRenderer: () => {},
    createAgentSession: async () => ({} as any),
  } as any;
}

describe("buildRepoMap", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-repomap-"));
  });

  afterEach(() => {
    rmDirWithRetry(tmpDir);
  });

  function write(rel: string, body: string): void {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }

  test("emits deterministic structural map without git", async () => {
    write("src/a.ts", `export function alpha() { return 1; }\nimport { beta } from "./b";`);
    write("src/b.ts", `export function beta() { return 2; }`);
    write("src/index.ts", `import { alpha } from "./a";\nimport { beta } from "./b";\nexport const main = () => alpha() + beta();`);

    const platform = makePlatform(tmpDir);
    const result = await buildRepoMap(platform, { cwd: tmpDir, tokenBudget: 2000 });

    expect(result.text).toContain("# Repository map");
    expect(result.text).toContain("src/a.ts");
    expect(result.text).toContain("src/b.ts");
    expect(result.text).toContain("src/index.ts");
    expect(result.fileCount).toBeGreaterThanOrEqual(3);
    expect(result.consideredFiles).toBeGreaterThanOrEqual(3);

    const second = await buildRepoMap(platform, { cwd: tmpDir, tokenBudget: 2000 });
    expect(second.text).toBe(result.text);
  });

  test("respects tokenignore and binary exclusions", async () => {
    write("src/keep.ts", `export const keep = 1;`);
    write("src/skip.ts", `export const skip = 1;`);
    write("assets/image.png", "binary");
    write(".omp/supipowers/.tokenignore", "src/skip.ts\n");

    const result = await buildRepoMap(makePlatform(tmpDir), { cwd: tmpDir });

    expect(result.text).toContain("src/keep.ts");
    expect(result.text).not.toContain("src/skip.ts");
    expect(result.text).not.toContain("assets/image.png");
  });

  test("personalizes ranking toward focus files", async () => {
    write("src/feature.ts", `export function feature() { return 1; }`);
    write("src/other.ts", `export function other() { return 2; }`);

    const result = await buildRepoMap(makePlatform(tmpDir), {
      cwd: tmpDir,
      focus: ["src/feature.ts"],
      tokenBudget: 4000,
    });

    const featureIdx = result.text.indexOf("src/feature.ts");
    const otherIdx = result.text.indexOf("src/other.ts");
    expect(featureIdx).toBeGreaterThanOrEqual(0);
    expect(otherIdx).toBeGreaterThanOrEqual(0);
    expect(featureIdx).toBeLessThan(otherIdx);
  });

  test("budget limits emitted bytes", async () => {
    for (let i = 0; i < 30; i += 1) {
      write(`src/file${i}.ts`, `export function fn${i}() { return ${i}; }`);
    }
    const result = await buildRepoMap(makePlatform(tmpDir), { cwd: tmpDir, tokenBudget: 200 });
    expect(result.emittedBytes).toBeLessThanOrEqual(200 * 4 + 200);
    expect(result.fileCount).toBeLessThan(30);
  });
});
