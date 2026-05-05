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

  test("enumerates tracked and untracked git files with tokenignore overlay", async () => {
    write("src/tracked.ts", `export function tracked() { return 1; }`);
    write("src/untracked.ts", `export function untracked() { return 2; }`);
    write("src/ignored-by-tokenignore.ts", `export function ignoredByTokenignore() { return 3; }`);
    write(".omp/supipowers/.tokenignore", "src/ignored-by-tokenignore.ts\n");

    const execCalls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const platform = {
      ...makePlatform(tmpDir),
      exec: async (cmd: string, args: string[], opts: { cwd: string }) => {
        execCalls.push({ cmd, args, cwd: opts.cwd });
        return {
          stdout: "src/tracked.ts\nsrc/untracked.ts\nsrc/ignored-by-tokenignore.ts\n",
          stderr: "",
          code: 0,
        };
      },
    };

    const result = await buildRepoMap(platform, { cwd: tmpDir, tokenBudget: 4000 });

    expect(execCalls).toEqual([
      { cmd: "git", args: ["ls-files", "--cached", "--others", "--exclude-standard"], cwd: tmpDir },
    ]);
    expect(result.text).toContain("src/tracked.ts");
    expect(result.text).toContain("src/untracked.ts");
    expect(result.text).not.toContain("src/ignored-by-tokenignore.ts");
  });

  test("applies gitignore and tokenignore filters during fallback walking", async () => {
    write("src/keep.ts", `export function keep() { return 1; }`);
    write("generated/generated.ts", `export function generated() { return 2; }`);
    write("src/skip-token.ts", `export function skipToken() { return 3; }`);
    write(".gitignore", "generated/\n");
    write(".omp/supipowers/.tokenignore", "src/skip-token.ts\n");

    const platform = {
      ...makePlatform(tmpDir),
      exec: async () => ({ stdout: "", stderr: "not a git repository", code: 1 }),
    };

    const result = await buildRepoMap(platform, { cwd: tmpDir, tokenBudget: 4000 });

    expect(result.text).toContain("src/keep.ts");
    expect(result.text).not.toContain("generated/generated.ts");
    expect(result.text).not.toContain("src/skip-token.ts");
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

  test("reports original source bytes for emitted files", async () => {
    const first = `export function first() { return 1; }\n`;
    const second = `export function second() { return 2; }\n`;
    write("src/first.ts", first);
    write("src/second.ts", second);

    const result = await buildRepoMap(makePlatform(tmpDir), { cwd: tmpDir, tokenBudget: 4000 });

    expect(result.text).toContain("src/first.ts");
    expect(result.text).toContain("src/second.ts");
    expect(result.emittedSourceBytes).toBe(
      new TextEncoder().encode(first).byteLength + new TextEncoder().encode(second).byteLength,
    );
  });
});
