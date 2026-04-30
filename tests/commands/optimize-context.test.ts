import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { handleOptimizeContext } from "../../src/commands/optimize-context.js";
import { parseManagedRule, renderManagedRule } from "../../src/context/rule-renderer.js";
import type { StartupOptimizerManifest } from "../../src/context/startup-check.js";
import type { WriteRuleAction } from "../../src/context/startup-optimizer.js";
import { MetricsStore, __setMetricsStoreForTest, _resetMetricsStoreCache } from "../../src/context-mode/metrics-store.js";
import { createMockPlatform } from "../../src/platform/test-utils.js";
import type { PlatformContext, PlatformPaths } from "../../src/platform/types.js";
import { rmDirWithRetry } from "../helpers/fs.js";

const SYSTEM_PROMPT = [
  "You are an OMP coding agent.",
  "# Skills",
  "Loaded skills follow.",
  "## debugging",
  "Systematic debugging guidance.",
  "## database-reference",
  "Occasional database migration reference.",
  "# Project",
  '<file path="/repo/AGENTS.md">',
  "# Repo rules",
  "Keep things simple.",
  "</file>",
].join("\n");

let tmpDir: string;
let platform: ReturnType<typeof createMockPlatform>;
let ctx: PlatformContext;
let selectMock: ReturnType<typeof mock>;
let notifyMock: ReturnType<typeof mock>;
let sendMessageMock: ReturnType<typeof mock>;
let metricsStore: MetricsStore | null = null;

function tmpPaths(): PlatformPaths {
  return {
    dotDir: ".omp",
    dotDirDisplay: ".omp",
    project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
    global: (...segments: string[]) => path.join(tmpDir, "global", ...segments),
    agent: (...segments: string[]) => path.join(tmpDir, "agent", ...segments),
  };
}

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-optimize-context-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }));
  fs.writeFileSync(path.join(tmpDir, "bun.lock"), "lockfile");

  selectMock = mock(async () => "Close");
  notifyMock = mock();
  sendMessageMock = mock();
  platform = createMockPlatform({
    paths: tmpPaths(),
    sendMessage: sendMessageMock as any,
  });

  ctx = {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      select: selectMock as any,
      notify: notifyMock as any,
      input: mock(async () => null) as any,
    },
  };
  (ctx as any).getSystemPrompt = () => SYSTEM_PROMPT;
}

beforeEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) rmDirWithRetry(tmpDir);
  setup();
});

afterEach(() => {
  if (metricsStore) {
    try { metricsStore.close(); } catch { /* already closed */ }
    metricsStore = null;
  }
  _resetMetricsStoreCache();
  if (tmpDir && fs.existsSync(tmpDir)) rmDirWithRetry(tmpDir);
});

async function run(args?: string): Promise<void> {
  await handleOptimizeContext(platform, ctx, args);
}

function projectPath(...segments: string[]): string {
  return path.join(tmpDir, ".omp", "supipowers", ...segments);
}

function rulesPath(): string {
  return path.join(tmpDir, ".omp", "rules");
}

function manifestPath(): string {
  return projectPath("context-optimizer", "manifest.json");
}

function tokenignorePath(): string {
  return projectPath(".tokenignore");
}

function rulePath(slug: string): string {
  return path.join(rulesPath(), `${slug}.md`);
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function existingManagedRule(overrides: Partial<WriteRuleAction> = {}): string {
  return renderManagedRule({
    kind: "write-rule",
    mode: "ttsr",
    sourceId: "skill:debugging",
    sourceName: "debugging",
    sourceHash: "c".repeat(64),
    slug: "skill-debugging",
    targetPath: ".omp/rules/skill-debugging.md",
    sourceBytes: 100,
    estimatedSavedBytes: 100,
    sourceContent: "## debugging\nstale guidance",
    condition: String.raw`\bdebug\b`,
    ...overrides,
  });
}

function notifyMessages(): string[] {
  return (notifyMock as any).mock.calls.map((call: any[]) => String(call[0]));
}

async function applyWithConfirmation(): Promise<void> {
  selectMock.mockImplementation(async () => "Apply");
  await run("--apply");
  selectMock.mockClear();
  notifyMock.mockClear();
  selectMock.mockImplementation(async () => "Close");
}

function useOptimizedPrompt(): void {
  (ctx as any).getSystemPrompt = () => "You are an optimized OMP coding agent.";
}

function installMetricsStore(): string {
  const dbPath = path.join(tmpDir, "metrics.db");
  metricsStore = new MetricsStore({ dbPath, projectSlug: "demo" });
  metricsStore.init();
  __setMetricsStoreForTest(metricsStore);
  return dbPath;
}

describe("/supi:optimize-context args and dry-run", () => {
  test("no args still shows the existing report and offers deterministic migration choices", async () => {
    await run();

    expect((selectMock as any).mock.calls.length).toBe(1);
    const [title, options, opts] = (selectMock as any).mock.calls[0];
    expect(title).toBe("Context Optimization");
    expect(options[0]).toContain("Tech:");
    expect(options[0]).toContain("Current:");
    expect(options).toContain("▶ Optimize with AI");
    expect(options).toContain("Apply deterministic migration");
    expect(options).toContain("Run check");
    expect(opts.helpText).toContain("Select an action");
  });

  test("dry-run previews the deterministic plan and writes no files", async () => {
    selectMock.mockImplementation(async () => "Close");

    await run("--dry-run");

    expect((selectMock as any).mock.calls.length).toBe(1);
    const [title, options, opts] = (selectMock as any).mock.calls[0];
    expect(title).toBe("Context Optimization Dry Run");
    expect(options.join("\n")).toContain("write-rule");
    expect(opts.helpText).toContain("Dry-run: no files will be written");
    expect(fs.existsSync(rulesPath())).toBe(false);
    expect(fs.existsSync(projectPath(".tokenignore"))).toBe(false);
    expect(fs.existsSync(projectPath("context-optimizer", "manifest.json"))).toBe(false);
  });

  test("--apply --dry-run uses the same no-write preview path", async () => {
    await run("--apply --dry-run");

    const [title, options, opts] = (selectMock as any).mock.calls[0];
    expect(title).toBe("Context Optimization Dry Run");
    expect(options.join("\n")).toContain("write-rule");
    expect(opts.helpText).toContain("Dry-run: no files will be written");
    expect(fs.existsSync(rulesPath())).toBe(false);
    expect(fs.existsSync(projectPath(".tokenignore"))).toBe(false);
    expect(fs.existsSync(projectPath("context-optimizer", "manifest.json"))).toBe(false);
  });
});


describe("/supi:optimize-context --apply", () => {
  test("confirmed apply writes managed rules, tokenignore, and manifest with check-required success messaging", async () => {
    selectMock.mockImplementation(async () => "Apply");

    await run("--apply");

    expect(fs.existsSync(rulePath("skill-debugging"))).toBe(true);
    expect(fs.existsSync(rulePath("skill-database-reference"))).toBe(true);
    expect(fs.existsSync(tokenignorePath())).toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true);

    const manifest = JSON.parse(readText(manifestPath())) as StartupOptimizerManifest;
    expect(manifest.rules.map((rule) => rule.slug).sort()).toEqual([
      "skill-database-reference",
      "skill-debugging",
    ]);
    expect(manifest.tokenignore.path).toBe(".omp/supipowers/.tokenignore");
    expect(manifest.manualActions.some((action) => action.kind === "manual-disable")).toBe(true);

    const parsedRule = parseManagedRule(readText(rulePath("skill-debugging")));
    expect(parsedRule.status).toBe("managed");
    if (parsedRule.status !== "managed") throw new Error("expected managed rule");
    expect(parsedRule.metadata.sourceId).toBe("skill:debugging");

    const joined = notifyMessages().join("\n");
    expect(joined).toContain("Restart OMP");
    expect(joined).toContain("/supi:optimize-context --check");
  });

  test("cancellation writes nothing", async () => {
    selectMock.mockImplementation(async () => "Cancel");

    await run("--apply");

    expect(fs.existsSync(rulesPath())).toBe(false);
    expect(fs.existsSync(tokenignorePath())).toBe(false);
    expect(fs.existsSync(manifestPath())).toBe(false);
    expect(notifyMessages().join("\n")).toContain("cancelled");
  });

  test("unmanaged rule conflict blocks writes and preserves the existing file", async () => {
    writeText(rulePath("skill-debugging"), "---\ndescription: user rule\n---\nuser body\n");
    selectMock.mockImplementation(async () => "Apply");

    await run("--apply");

    expect(readText(rulePath("skill-debugging"))).toContain("user body");
    expect(fs.existsSync(manifestPath())).toBe(false);
    expect(notifyMessages().join("\n")).toContain("unmanaged");
  });

  test("managed rule hash drift is a confirmable update candidate", async () => {
    writeText(rulePath("skill-debugging"), existingManagedRule());
    selectMock.mockImplementation(async () => "Cancel");

    await run("--apply");

    const [title, options, opts] = (selectMock as any).mock.calls[0];
    expect(title).toBe("Apply deterministic context migration?");
    expect(options).toEqual(["Apply", "Cancel"]);
    expect(opts.helpText).toContain("update");
    expect(readText(rulePath("skill-debugging"))).toContain("stale guidance");
    expect(fs.existsSync(manifestPath())).toBe(false);
  });

  test("malformed existing manifest refuses apply before writing", async () => {
    writeText(manifestPath(), "{not json");
    selectMock.mockImplementation(async () => "Apply");

    await run("--apply");

    expect(readText(manifestPath())).toBe("{not json");
    expect(fs.existsSync(rulePath("skill-debugging"))).toBe(false);
    expect(notifyMessages().join("\n")).toContain("Remove or repair");
  });

  test("managed re-run is idempotent", async () => {
    selectMock.mockImplementation(async () => "Apply");
    await run("--apply");

    const first = {
      debugRule: readText(rulePath("skill-debugging")),
      referenceRule: readText(rulePath("skill-database-reference")),
      tokenignore: readText(tokenignorePath()),
      manifest: readText(manifestPath()),
    };

    selectMock.mockClear();
    notifyMock.mockClear();
    selectMock.mockImplementation(async () => "Apply");
    await run("--apply");

    expect(readText(rulePath("skill-debugging"))).toBe(first.debugRule);
    expect(readText(rulePath("skill-database-reference"))).toBe(first.referenceRule);
    expect(readText(tokenignorePath())).toBe(first.tokenignore);
    expect(readText(manifestPath())).toBe(first.manifest);
  });

  test("missing getSystemPrompt blocks apply truthfully", async () => {
    delete (ctx as any).getSystemPrompt;
    selectMock.mockImplementation(async () => "Apply");

    await run("--apply");

    expect(fs.existsSync(rulesPath())).toBe(false);
    expect(fs.existsSync(manifestPath())).toBe(false);
    expect(notifyMessages().join("\n")).toContain("System prompt unavailable");
  });

  test("headless apply returns without writes", async () => {
    ctx.hasUI = false;

    await run("--apply");

    expect(fs.existsSync(rulesPath())).toBe(false);
    expect(fs.existsSync(manifestPath())).toBe(false);
  });

  test("manifest is consistent with already-written managed artifacts", async () => {
    selectMock.mockImplementation(async () => "Apply");

    await run("--apply");

    const manifest = JSON.parse(readText(manifestPath())) as StartupOptimizerManifest;
    for (const rule of manifest.rules) {
      const absoluteRulePath = path.join(tmpDir, rule.path);
      expect(fs.existsSync(absoluteRulePath)).toBe(true);
      const parsed = parseManagedRule(readText(absoluteRulePath));
      expect(parsed.status).toBe("managed");
      if (parsed.status !== "managed") throw new Error("expected managed rule");
      expect(parsed.metadata.sourceId).toBe(rule.sourceId);
      expect(parsed.metadata.sourceHash).toBe(rule.sourceHash);
    }
  });
});

describe("/supi:optimize-context --check", () => {
  test("renders pass summary from startup check", async () => {
    await applyWithConfirmation();
    useOptimizedPrompt();

    await run("--check");

    const joined = notifyMessages().join("\n");
    expect(joined).toContain("Startup optimization check: pass");
    expect(joined).toContain("Current prompt:");
  });

  test("renders fail summary with remediation reasons", async () => {
    await applyWithConfirmation();

    await run("--check");

    const joined = notifyMessages().join("\n");
    expect(joined).toContain("Startup optimization check: fail");
    expect(joined).toContain("still-loaded-source");
  });

  test("fails with prompt-unavailable when getSystemPrompt is missing", async () => {
    await applyWithConfirmation();
    delete (ctx as any).getSystemPrompt;

    await run("--check");

    const joined = notifyMessages().join("\n");
    expect(joined).toContain("prompt-unavailable");
    expect(joined).toContain("Startup optimization check: fail");
  });

  test("headless check returns without writes", async () => {
    ctx.hasUI = false;

    await run("--check");

    expect(fs.existsSync(manifestPath())).toBe(false);
    expect(notifyMessages()).toEqual([]);
  });

  test("successful check writes one L6 startup-optimizer metrics row", async () => {
    await applyWithConfirmation();
    useOptimizedPrompt();
    const dbPath = installMetricsStore();

    await run("--check");
    await metricsStore!.flushPendingForTest();

    const probe = new Database(dbPath, { readonly: true });
    try {
      const rows = probe.prepare(
        `SELECT layer, tool, processor, before_bytes, after_bytes, cache_hit, unique_source_hash FROM metrics`,
      ).all() as Array<{
        layer: string;
        tool: string;
        processor: string;
        before_bytes: number;
        after_bytes: number;
        cache_hit: number;
        unique_source_hash: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        layer: "L6",
        tool: "(system)",
        processor: "startup-optimizer",
        cache_hit: 0,
      });
      const manifest = JSON.parse(readText(manifestPath())) as StartupOptimizerManifest;
      expect(rows[0].before_bytes).toBe(manifest.beforeBytes);
      expect(rows[0].after_bytes).toBe(new TextEncoder().encode((ctx as any).getSystemPrompt()).length);
      expect(rows[0].unique_source_hash).toBe(manifest.sourceSetHash);
    } finally {
      probe.close();
    }
  });

  test("metrics-store failures are swallowed", async () => {
    await applyWithConfirmation();
    useOptimizedPrompt();
    __setMetricsStoreForTest({
      record() {
        throw new Error("metrics unavailable");
      },
    } as any);

    await run("--check");

    expect(notifyMessages().join("\n")).toContain("Startup optimization check: pass");
  });
});