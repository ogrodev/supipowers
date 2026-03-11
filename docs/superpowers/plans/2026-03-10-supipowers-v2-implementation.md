# Supipowers v2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OMP-native extension that provides superpowers-style agentic workflows with action-driven commands, opt-in quality gates, sub-agent orchestration, and LSP integration.

**Architecture:** TypeScript OMP extension registering slash commands and tools via `ExtensionAPI`. No state machine — commands are independent actions that read/write artifacts to `.omp/supipowers/`. Sub-agents dispatched via OMP's `createAgentSession`. Notifications via `ctx.ui.notify` and `sendMessage`.

**Tech Stack:** TypeScript, `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui`, `@sinclair/typebox`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-10-supipowers-v2-design.md`

---

## Chunk 1: Foundation — Project Scaffolding, Types, Config, Storage

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsconfig.build.json`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "supipowers",
  "version": "0.1.0",
  "description": "OMP-native workflow extension inspired by Superpowers.",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "test:watch": "vitest",
    "build": "tsc -p tsconfig.build.json"
  },
  "keywords": ["omp-extension", "workflow", "agent", "superpowers"],
  "license": "MIT",
  "files": ["src", "skills", "README.md", "LICENSE"],
  "peerDependencies": {
    "@oh-my-pi/pi-coding-agent": "*",
    "@oh-my-pi/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "latest",
    "@oh-my-pi/pi-tui": "latest",
    "@sinclair/typebox": "^0.34.48",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.0"
  },
  "omp": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.omp/supipowers/runs/
.omp/supipowers/reports/
```

- [ ] **Step 6: Install dependencies**

Run: `bun install`
Expected: Dependencies installed successfully

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore bun.lock
git commit -m "feat: scaffold project with omp extension structure"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// src/types.ts — Shared type definitions for supipowers

/** Sub-agent execution status */
export type AgentStatus = "done" | "done_with_concerns" | "blocked";

/** Task complexity level */
export type TaskComplexity = "small" | "medium" | "large";

/** Task parallelism annotation */
export type TaskParallelism =
  | { type: "parallel-safe" }
  | { type: "sequential"; dependsOn: number[] };

/** A single task in a plan */
export interface PlanTask {
  id: number;
  name: string;
  description: string;
  files: string[];
  criteria: string;
  complexity: TaskComplexity;
  parallelism: TaskParallelism;
}

/** A plan document (parsed from markdown) */
export interface Plan {
  name: string;
  created: string;
  tags: string[];
  context: string;
  tasks: PlanTask[];
  filePath: string;
}

/** Per-agent result stored after execution */
export interface AgentResult {
  taskId: number;
  status: AgentStatus;
  output: string;
  concerns?: string;
  filesChanged: string[];
  duration: number;
}

/** Batch status in a run */
export type BatchStatus = "pending" | "running" | "completed" | "failed";

/** A batch of tasks in a run */
export interface RunBatch {
  index: number;
  taskIds: number[];
  status: BatchStatus;
}

/** Overall run status */
export type RunStatus = "running" | "completed" | "paused" | "failed";

/** Run manifest stored on disk */
export interface RunManifest {
  id: string;
  planRef: string;
  profile: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  batches: RunBatch[];
}

/** Notification severity level */
export type NotificationLevel = "success" | "warning" | "error" | "info" | "summary";

/** Notification payload */
export interface Notification {
  level: NotificationLevel;
  title: string;
  detail?: string;
}

/** Quality gate result */
export interface GateResult {
  gate: string;
  passed: boolean;
  issues: GateIssue[];
}

/** A single issue from a quality gate */
export interface GateIssue {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
}

/** Review report */
export interface ReviewReport {
  profile: string;
  timestamp: string;
  gates: GateResult[];
  passed: boolean;
}

/** Config shape */
export interface SupipowersConfig {
  version: string;
  defaultProfile: string;
  orchestration: {
    maxParallelAgents: number;
    maxFixRetries: number;
    maxNestingDepth: number;
    modelPreference: string;
  };
  lsp: {
    autoDetect: boolean;
    setupGuide: boolean;
  };
  notifications: {
    verbosity: "quiet" | "normal" | "verbose";
  };
  qa: {
    framework: string | null;
    command: string | null;
  };
  release: {
    pipeline: string | null;
  };
}

/** Profile shape */
export interface Profile {
  name: string;
  gates: {
    lspDiagnostics: boolean;
    aiReview: { enabled: boolean; depth: "quick" | "deep" };
    codeQuality: boolean;
    testSuite: boolean;
    e2e: boolean;
  };
  orchestration: {
    reviewAfterEachBatch: boolean;
    finalReview: boolean;
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

### Task 3: Config System

**Files:**
- Create: `src/config/defaults.ts`
- Create: `src/config/schema.ts`
- Create: `src/config/loader.ts`
- Create: `src/config/profiles.ts`
- Test: `tests/config/loader.test.ts`
- Test: `tests/config/profiles.test.ts`

- [ ] **Step 1: Write defaults**

```ts
// src/config/defaults.ts
import type { SupipowersConfig, Profile } from "../types.js";

export const DEFAULT_CONFIG: SupipowersConfig = {
  version: "1.0.0",
  defaultProfile: "thorough",
  orchestration: {
    maxParallelAgents: 3,
    maxFixRetries: 2,
    maxNestingDepth: 2,
    modelPreference: "auto",
  },
  lsp: {
    autoDetect: true,
    setupGuide: true,
  },
  notifications: {
    verbosity: "normal",
  },
  qa: {
    framework: null,
    command: null,
  },
  release: {
    pipeline: null,
  },
};

export const BUILTIN_PROFILES: Record<string, Profile> = {
  quick: {
    name: "quick",
    gates: {
      lspDiagnostics: true,
      aiReview: { enabled: true, depth: "quick" },
      codeQuality: false,
      testSuite: false,
      e2e: false,
    },
    orchestration: {
      reviewAfterEachBatch: false,
      finalReview: false,
    },
  },
  thorough: {
    name: "thorough",
    gates: {
      lspDiagnostics: true,
      aiReview: { enabled: true, depth: "deep" },
      codeQuality: true,
      testSuite: false,
      e2e: false,
    },
    orchestration: {
      reviewAfterEachBatch: true,
      finalReview: true,
    },
  },
  "full-regression": {
    name: "full-regression",
    gates: {
      lspDiagnostics: true,
      aiReview: { enabled: true, depth: "deep" },
      codeQuality: true,
      testSuite: true,
      e2e: true,
    },
    orchestration: {
      reviewAfterEachBatch: true,
      finalReview: true,
    },
  },
};
```

- [ ] **Step 2: Write schema validation**

```ts
// src/config/schema.ts
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SupipowersConfig, Profile } from "../types.js";

const ConfigSchema = Type.Object({
  version: Type.String(),
  defaultProfile: Type.String(),
  orchestration: Type.Object({
    maxParallelAgents: Type.Number({ minimum: 1, maximum: 10 }),
    maxFixRetries: Type.Number({ minimum: 0, maximum: 5 }),
    maxNestingDepth: Type.Number({ minimum: 0, maximum: 5 }),
    modelPreference: Type.String(),
  }),
  lsp: Type.Object({
    autoDetect: Type.Boolean(),
    setupGuide: Type.Boolean(),
  }),
  notifications: Type.Object({
    verbosity: Type.Union([
      Type.Literal("quiet"),
      Type.Literal("normal"),
      Type.Literal("verbose"),
    ]),
  }),
  qa: Type.Object({
    framework: Type.Union([Type.String(), Type.Null()]),
    command: Type.Union([Type.String(), Type.Null()]),
  }),
  release: Type.Object({
    pipeline: Type.Union([Type.String(), Type.Null()]),
  }),
});

export function validateConfig(data: unknown): { valid: boolean; errors: string[] } {
  const valid = Value.Check(ConfigSchema, data);
  if (valid) return { valid: true, errors: [] };
  const errors = [...Value.Errors(ConfigSchema, data)].map(
    (e) => `${e.path}: ${e.message}`
  );
  return { valid: false, errors };
}
```

- [ ] **Step 3: Write config loader**

```ts
// src/config/loader.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { SupipowersConfig } from "../types.js";
import { DEFAULT_CONFIG } from "./defaults.js";

const PROJECT_CONFIG_PATH = [".omp", "supipowers", "config.json"];
const GLOBAL_CONFIG_DIR = ".omp";
const GLOBAL_CONFIG_PATH = ["supipowers", "config.json"];

function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, ...PROJECT_CONFIG_PATH);
}

function getGlobalConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, GLOBAL_CONFIG_DIR, ...GLOBAL_CONFIG_PATH);
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Deep merge source into target. Source values override target. */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = (result as Record<string, unknown>)[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else {
      (result as Record<string, unknown>)[key] = sourceVal;
    }
  }
  return result;
}

/** Load config with global → project layering over defaults.
 *  Validates and migrates if version is outdated. */
export function loadConfig(cwd: string): SupipowersConfig {
  const globalData = readJsonSafe(getGlobalConfigPath());
  const projectData = readJsonSafe(getProjectConfigPath(cwd));

  let config = { ...DEFAULT_CONFIG };
  if (globalData) config = deepMerge(config, globalData);
  if (projectData) config = deepMerge(config, projectData);

  // Migrate if version is older than current default
  if (config.version !== DEFAULT_CONFIG.version) {
    config = migrateConfig(config);
    // Persist migrated config if project-level exists
    if (projectData) saveConfig(cwd, config);
  }

  return config;
}

/** Migrate config from older versions to current */
function migrateConfig(config: SupipowersConfig): SupipowersConfig {
  // Currently v1.0.0 is the only version — future migrations go here
  // Each migration handles one version bump:
  // if (config.version === "0.x.x") { ... config.version = "1.0.0"; }
  return { ...config, version: DEFAULT_CONFIG.version };
}

/** Save project-level config */
export function saveConfig(cwd: string, config: SupipowersConfig): void {
  const configPath = getProjectConfigPath(cwd);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Update specific config fields (deep merge into current) */
export function updateConfig(
  cwd: string,
  updates: Record<string, unknown>
): SupipowersConfig {
  const current = loadConfig(cwd);
  const updated = deepMerge(current, updates);
  saveConfig(cwd, updated);
  return updated;
}
```

- [ ] **Step 4: Write profiles module**

```ts
// src/config/profiles.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { Profile, SupipowersConfig } from "../types.js";
import { BUILTIN_PROFILES } from "./defaults.js";

const PROFILES_DIR = [".omp", "supipowers", "profiles"];

function getProfilesDir(cwd: string): string {
  return path.join(cwd, ...PROFILES_DIR);
}

/** Load a profile by name. Checks project dir first, then built-ins. */
export function loadProfile(cwd: string, name: string): Profile | null {
  // Check project-level custom profiles
  const customPath = path.join(getProfilesDir(cwd), `${name}.json`);
  if (fs.existsSync(customPath)) {
    try {
      return JSON.parse(fs.readFileSync(customPath, "utf-8")) as Profile;
    } catch {
      // fall through to built-in
    }
  }
  return BUILTIN_PROFILES[name] ?? null;
}

/** Resolve the active profile from config, with optional override */
export function resolveProfile(
  cwd: string,
  config: SupipowersConfig,
  override?: string
): Profile {
  const name = override ?? config.defaultProfile;
  const profile = loadProfile(cwd, name);
  if (!profile) {
    // Fallback to thorough if configured profile doesn't exist
    return BUILTIN_PROFILES["thorough"];
  }
  return profile;
}

/** List all available profiles (built-in + custom) */
export function listProfiles(cwd: string): string[] {
  const names = new Set(Object.keys(BUILTIN_PROFILES));
  const dir = getProfilesDir(cwd);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".json")) {
        names.add(file.replace(".json", ""));
      }
    }
  }
  return [...names].sort();
}

/** Save a custom profile */
export function saveProfile(cwd: string, profile: Profile): void {
  const dir = getProfilesDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${profile.name}.json`),
    JSON.stringify(profile, null, 2) + "\n"
  );
}
```

- [ ] **Step 5: Write config loader tests**

```ts
// tests/config/loader.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, saveConfig, updateConfig, deepMerge } from "../../src/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

describe("deepMerge", () => {
  test("merges nested objects", () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  test("source overrides scalars", () => {
    const target = { a: 1 };
    const source = { a: 2 };
    expect(deepMerge(target, source)).toEqual({ a: 2 });
  });

  test("handles null values in source", () => {
    const target = { a: { b: 1 } };
    const source = { a: null };
    expect(deepMerge(target, source as any)).toEqual({ a: null });
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns defaults when no config files exist", () => {
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("merges project config over defaults", () => {
    const configDir = path.join(tmpDir, ".omp", "supipowers");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ orchestration: { maxParallelAgents: 5 } })
    );
    const config = loadConfig(tmpDir);
    expect(config.orchestration.maxParallelAgents).toBe(5);
    expect(config.orchestration.maxFixRetries).toBe(2); // inherited from default
  });
});

describe("saveConfig / updateConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("saveConfig creates dirs and writes file", () => {
    saveConfig(tmpDir, DEFAULT_CONFIG);
    const filePath = path.join(tmpDir, ".omp", "supipowers", "config.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.version).toBe("1.0.0");
  });

  test("updateConfig deep-merges and persists", () => {
    const updated = updateConfig(tmpDir, { orchestration: { maxParallelAgents: 7 } });
    expect(updated.orchestration.maxParallelAgents).toBe(7);
    expect(updated.orchestration.maxFixRetries).toBe(2);
    // Verify it was persisted
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.orchestration.maxParallelAgents).toBe(7);
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test -- tests/config/loader.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Write profiles tests**

```ts
// tests/config/profiles.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProfile, resolveProfile, listProfiles, saveProfile } from "../../src/config/profiles.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { BUILTIN_PROFILES } from "../../src/config/defaults.js";

describe("loadProfile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads built-in profile", () => {
    const profile = loadProfile(tmpDir, "quick");
    expect(profile).toEqual(BUILTIN_PROFILES["quick"]);
  });

  test("returns null for unknown profile", () => {
    expect(loadProfile(tmpDir, "nonexistent")).toBeNull();
  });

  test("custom profile overrides built-in", () => {
    const custom = { ...BUILTIN_PROFILES["quick"], name: "quick", gates: { ...BUILTIN_PROFILES["quick"].gates, codeQuality: true } };
    saveProfile(tmpDir, custom);
    const loaded = loadProfile(tmpDir, "quick");
    expect(loaded?.gates.codeQuality).toBe(true);
  });
});

describe("resolveProfile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves from config default", () => {
    const profile = resolveProfile(tmpDir, DEFAULT_CONFIG);
    expect(profile.name).toBe("thorough");
  });

  test("override takes precedence", () => {
    const profile = resolveProfile(tmpDir, DEFAULT_CONFIG, "quick");
    expect(profile.name).toBe("quick");
  });

  test("falls back to thorough for missing profile", () => {
    const config = { ...DEFAULT_CONFIG, defaultProfile: "missing" };
    const profile = resolveProfile(tmpDir, config);
    expect(profile.name).toBe("thorough");
  });
});

describe("listProfiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("lists built-in profiles", () => {
    const profiles = listProfiles(tmpDir);
    expect(profiles).toContain("quick");
    expect(profiles).toContain("thorough");
    expect(profiles).toContain("full-regression");
  });

  test("includes custom profiles", () => {
    saveProfile(tmpDir, { ...BUILTIN_PROFILES["quick"], name: "custom" });
    const profiles = listProfiles(tmpDir);
    expect(profiles).toContain("custom");
  });
});
```

- [ ] **Step 8: Run tests**

Run: `bun run test -- tests/config/profiles.test.ts`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/config/ tests/config/
git commit -m "feat: add config system with layered loading and profiles"
```

---

### Task 4: Storage Layer

**Files:**
- Create: `src/storage/plans.ts`
- Create: `src/storage/runs.ts`
- Create: `src/storage/reports.ts`
- Test: `tests/storage/runs.test.ts`

- [ ] **Step 1: Write plans storage**

```ts
// src/storage/plans.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plan, PlanTask, TaskComplexity, TaskParallelism } from "../types.js";

const PLANS_DIR = [".omp", "supipowers", "plans"];

function getPlansDir(cwd: string): string {
  return path.join(cwd, ...PLANS_DIR);
}

/** List all saved plans */
export function listPlans(cwd: string): string[] {
  const dir = getPlansDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
}

/** Read a plan file by name */
export function readPlanFile(cwd: string, name: string): string | null {
  const filePath = path.join(getPlansDir(cwd), name);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/** Save a plan markdown file */
export function savePlan(cwd: string, filename: string, content: string): string {
  const dir = getPlansDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Parse a plan markdown file into a Plan object */
export function parsePlan(content: string, filePath: string): Plan {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, string | string[]> = {};

  if (frontmatterMatch) {
    for (const line of frontmatterMatch[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        meta[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim());
      } else {
        meta[key] = val;
      }
    }
  }

  const tasks = parseTasksFromMarkdown(content);

  return {
    name: (meta.name as string) ?? path.basename(filePath, ".md"),
    created: (meta.created as string) ?? "",
    tags: (meta.tags as string[]) ?? [],
    context: extractContext(content),
    tasks,
    filePath,
  };
}

function extractContext(content: string): string {
  const contextMatch = content.match(/## Context\n\n([\s\S]*?)(?=\n## |$)/);
  return contextMatch?.[1]?.trim() ?? "";
}

function parseTasksFromMarkdown(content: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const taskRegex = /### (\d+)\. (.+)/g;
  let match: RegExpExecArray | null;

  while ((match = taskRegex.exec(content)) !== null) {
    const id = parseInt(match[1], 10);
    const headerLine = match[2];
    const startIdx = match.index + match[0].length;
    const nextTaskMatch = /\n### \d+\. /.exec(content.slice(startIdx));
    const endIdx = nextTaskMatch
      ? startIdx + nextTaskMatch.index
      : content.length;
    const body = content.slice(startIdx, endIdx);

    const name = headerLine.replace(/\[.*?\]/g, "").trim();
    const parallelism = parseParallelism(headerLine);
    const files = parseFiles(body);
    const criteria = parseCriteria(body);
    const complexity = parseComplexity(body);

    tasks.push({ id, name, description: name, files, criteria, complexity, parallelism });
  }
  return tasks;
}

function parseParallelism(header: string): TaskParallelism {
  if (header.includes("[parallel-safe]")) return { type: "parallel-safe" };
  const seqMatch = header.match(/\[sequential: depends on (\d[\d, ]*)\]/);
  if (seqMatch) {
    const deps = seqMatch[1].split(",").map((s) => parseInt(s.trim(), 10));
    return { type: "sequential", dependsOn: deps };
  }
  return { type: "sequential", dependsOn: [] };
}

function parseFiles(body: string): string[] {
  const filesMatch = body.match(/\*\*files?\*\*:\s*(.+)/i);
  if (!filesMatch) return [];
  return filesMatch[1].split(",").map((s) => s.trim());
}

function parseCriteria(body: string): string {
  const match = body.match(/\*\*criteria\*\*:\s*(.+)/i);
  return match?.[1]?.trim() ?? "";
}

function parseComplexity(body: string): TaskComplexity {
  const match = body.match(/\*\*complexity\*\*:\s*(\w+)/i);
  const val = match?.[1]?.toLowerCase();
  if (val === "small" || val === "medium" || val === "large") return val;
  return "medium";
}
```

- [ ] **Step 2: Write runs storage**

```ts
// src/storage/runs.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunManifest, AgentResult } from "../types.js";

const RUNS_DIR = [".omp", "supipowers", "runs"];

function getRunsDir(cwd: string): string {
  return path.join(cwd, ...RUNS_DIR);
}

function getRunDir(cwd: string, runId: string): string {
  return path.join(getRunsDir(cwd), runId);
}

/** Generate a unique run ID */
export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `run-${date}-${time}-${suffix}`;
}

/** Create a new run */
export function createRun(cwd: string, manifest: RunManifest): void {
  const runDir = getRunDir(cwd, manifest.id);
  fs.mkdirSync(path.join(runDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

/** Load a run manifest */
export function loadRun(cwd: string, runId: string): RunManifest | null {
  const filePath = path.join(getRunDir(cwd, runId), "manifest.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Update a run manifest */
export function updateRun(cwd: string, manifest: RunManifest): void {
  const filePath = path.join(getRunDir(cwd, manifest.id), "manifest.json");
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
}

/** Save an agent result */
export function saveAgentResult(
  cwd: string,
  runId: string,
  result: AgentResult
): void {
  const filePath = path.join(
    getRunDir(cwd, runId),
    "agents",
    `task-${result.taskId}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + "\n");
}

/** Load an agent result */
export function loadAgentResult(
  cwd: string,
  runId: string,
  taskId: number
): AgentResult | null {
  const filePath = path.join(
    getRunDir(cwd, runId),
    "agents",
    `task-${taskId}.json`
  );
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Load all agent results for a run */
export function loadAllAgentResults(
  cwd: string,
  runId: string
): AgentResult[] {
  const agentsDir = path.join(getRunDir(cwd, runId), "agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(agentsDir, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter((r): r is AgentResult => r !== null);
}

/** List all runs, newest first */
export function listRuns(cwd: string): string[] {
  const dir = getRunsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("run-"))
    .sort()
    .reverse();
}

/** Find the latest active run (running or paused) */
export function findActiveRun(cwd: string): RunManifest | null {
  for (const runId of listRuns(cwd)) {
    const manifest = loadRun(cwd, runId);
    if (manifest && (manifest.status === "running" || manifest.status === "paused")) {
      return manifest;
    }
  }
  return null;
}
```

- [ ] **Step 3: Write reports storage**

```ts
// src/storage/reports.ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewReport } from "../types.js";

const REPORTS_DIR = [".omp", "supipowers", "reports"];

function getReportsDir(cwd: string): string {
  return path.join(cwd, ...REPORTS_DIR);
}

/** Save a review report */
export function saveReviewReport(cwd: string, report: ReviewReport): string {
  const dir = getReportsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `review-${report.timestamp.slice(0, 10)}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + "\n");
  return filePath;
}

/** Load the latest review report */
export function loadLatestReport(cwd: string): ReviewReport | null {
  const dir = getReportsDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("review-") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Write runs tests**

```ts
// tests/storage/runs.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateRunId,
  createRun,
  loadRun,
  updateRun,
  saveAgentResult,
  loadAgentResult,
  loadAllAgentResults,
  findActiveRun,
} from "../../src/storage/runs.js";
import type { RunManifest, AgentResult } from "../../src/types.js";

describe("runs storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("generateRunId returns expected format", () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  test("generateRunId produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateRunId()));
    expect(ids.size).toBe(10);
  });

  test("createRun and loadRun roundtrip", () => {
    const manifest: RunManifest = {
      id: "run-20260310-143052",
      planRef: "test-plan.md",
      profile: "thorough",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [{ index: 0, taskIds: [1, 2], status: "pending" }],
    };
    createRun(tmpDir, manifest);
    const loaded = loadRun(tmpDir, manifest.id);
    expect(loaded).toEqual(manifest);
  });

  test("updateRun persists changes", () => {
    const manifest: RunManifest = {
      id: "run-20260310-143052",
      planRef: "test.md",
      profile: "quick",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [{ index: 0, taskIds: [1], status: "pending" }],
    };
    createRun(tmpDir, manifest);
    manifest.status = "completed";
    updateRun(tmpDir, manifest);
    expect(loadRun(tmpDir, manifest.id)?.status).toBe("completed");
  });

  test("agent results roundtrip", () => {
    const manifest: RunManifest = {
      id: "run-test",
      planRef: "test.md",
      profile: "quick",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [],
    };
    createRun(tmpDir, manifest);

    const result: AgentResult = {
      taskId: 1,
      status: "done",
      output: "implemented feature",
      filesChanged: ["src/foo.ts"],
      duration: 5000,
    };
    saveAgentResult(tmpDir, "run-test", result);
    expect(loadAgentResult(tmpDir, "run-test", 1)).toEqual(result);
    expect(loadAllAgentResults(tmpDir, "run-test")).toHaveLength(1);
  });

  test("findActiveRun returns running run", () => {
    const manifest: RunManifest = {
      id: "run-active",
      planRef: "test.md",
      profile: "quick",
      status: "running",
      startedAt: new Date().toISOString(),
      batches: [],
    };
    createRun(tmpDir, manifest);
    expect(findActiveRun(tmpDir)?.id).toBe("run-active");
  });

  test("findActiveRun returns null when no active runs", () => {
    expect(findActiveRun(tmpDir)).toBeNull();
  });
});
```

- [ ] **Step 5: Write plan parser tests**

```ts
// tests/storage/plans.test.ts
import { describe, test, expect } from "vitest";
import { parsePlan } from "../../src/storage/plans.js";

const SAMPLE_PLAN = `---
name: auth-refactor
created: 2026-03-10
tags: [auth, api]
---

# Auth Refactor

## Context
Refactoring the auth module for better separation.

## Tasks

### 1. Extract middleware [parallel-safe]
- **files**: src/middleware/auth.ts, src/middleware/index.ts
- **criteria**: Auth logic extracted, existing tests pass
- **complexity**: small

### 2. Add JWT validation [sequential: depends on 1]
- **files**: src/middleware/auth.ts, src/utils/jwt.ts
- **criteria**: JWT tokens validated, unit tests added
- **complexity**: medium
`;

describe("parsePlan", () => {
  test("parses frontmatter", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.name).toBe("auth-refactor");
    expect(plan.created).toBe("2026-03-10");
    expect(plan.tags).toEqual(["auth", "api"]);
  });

  test("extracts context", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.context).toBe("Refactoring the auth module for better separation.");
  });

  test("parses tasks", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks).toHaveLength(2);
  });

  test("parses parallel-safe annotation", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].parallelism).toEqual({ type: "parallel-safe" });
  });

  test("parses sequential annotation with dependencies", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[1].parallelism).toEqual({ type: "sequential", dependsOn: [1] });
  });

  test("parses files list", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].files).toEqual(["src/middleware/auth.ts", "src/middleware/index.ts"]);
  });

  test("parses complexity", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].complexity).toBe("small");
    expect(plan.tasks[1].complexity).toBe("medium");
  });

  test("parses criteria", () => {
    const plan = parsePlan(SAMPLE_PLAN, "test-plan.md");
    expect(plan.tasks[0].criteria).toBe("Auth logic extracted, existing tests pass");
  });
});
```

- [ ] **Step 6: Run all storage tests**

Run: `bun run test tests/storage/`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/storage/ tests/storage/
git commit -m "feat: add storage layer for plans, runs, and reports"
```

---

### Task 5: Notification System

**Files:**
- Create: `src/notifications/types.ts`
- Create: `src/notifications/renderer.ts`
- Test: `tests/notifications/renderer.test.ts`

- [ ] **Step 1: Write notification types (re-export from main types + add internals)**

```ts
// src/notifications/types.ts
export type { Notification, NotificationLevel } from "../types.js";

/** Icons mapped to notification levels */
export const LEVEL_ICONS: Record<string, string> = {
  success: "\u2713",  // ✓
  warning: "\u26A0",  // ⚠
  error: "\u2717",    // ✗
  info: "\u25C9",     // ◉
  summary: "\u25B8",  // ▸
};

/** Map notification levels to ctx.ui.notify types */
export const NOTIFY_TYPE_MAP: Record<string, "info" | "warning" | "error"> = {
  success: "info",
  warning: "warning",
  error: "error",
  info: "info",
  summary: "info",
};
```

- [ ] **Step 2: Write renderer**

```ts
// src/notifications/renderer.ts
import type { Notification } from "../types.js";
import { LEVEL_ICONS, NOTIFY_TYPE_MAP } from "./types.js";

/** Format a notification into a styled text string */
export function formatNotification(notification: Notification): string {
  const icon = LEVEL_ICONS[notification.level] ?? "";
  const parts = [`${icon} ${notification.title}`];
  if (notification.detail) {
    parts.push(` \u2014 ${notification.detail}`);
  }
  return parts.join("");
}

/** Send a notification through OMP's UI */
export function sendNotification(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  notification: Notification
): void {
  const message = formatNotification(notification);
  const type = NOTIFY_TYPE_MAP[notification.level] ?? "info";
  ctx.ui.notify(message, type);
}

/** Convenience: send a success notification */
export function notifySuccess(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "success", title, detail });
}

/** Convenience: send a warning notification */
export function notifyWarning(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "warning", title, detail });
}

/** Convenience: send an error notification */
export function notifyError(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "error", title, detail });
}

/** Convenience: send an info notification */
export function notifyInfo(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "info", title, detail });
}

/** Convenience: send a summary notification */
export function notifySummary(
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
  title: string,
  detail?: string
): void {
  sendNotification(ctx, { level: "summary", title, detail });
}
```

- [ ] **Step 3: Write tests**

```ts
// tests/notifications/renderer.test.ts
import { describe, test, expect, vi } from "vitest";
import { formatNotification, sendNotification } from "../../src/notifications/renderer.js";

describe("formatNotification", () => {
  test("formats success with icon", () => {
    const result = formatNotification({ level: "success", title: "Task done" });
    expect(result).toContain("\u2713");
    expect(result).toContain("Task done");
  });

  test("includes detail when provided", () => {
    const result = formatNotification({
      level: "error",
      title: "Task failed",
      detail: "missing file",
    });
    expect(result).toContain("Task failed");
    expect(result).toContain("missing file");
  });
});

describe("sendNotification", () => {
  test("calls ctx.ui.notify with correct type", () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    sendNotification(ctx, { level: "error", title: "Oops" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Oops"), "error");
  });

  test("maps success level to info type", () => {
    const notify = vi.fn();
    const ctx = { ui: { notify } };
    sendNotification(ctx, { level: "success", title: "Done" });
    expect(notify).toHaveBeenCalledWith(expect.any(String), "info");
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun run test -- tests/notifications/renderer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifications/ tests/notifications/
git commit -m "feat: add notification system with level-based rendering"
```

---

## Chunk 2: LSP Integration & Extension Entry Point

### Task 6: LSP Integration Layer

**Files:**
- Create: `src/lsp/detector.ts`
- Create: `src/lsp/bridge.ts`
- Create: `src/lsp/setup-guide.ts`
- Test: `tests/lsp/detector.test.ts`

- [ ] **Step 1: Write LSP detector**

```ts
// src/lsp/detector.ts
import type { SupipowersConfig } from "../types.js";

export interface LspStatus {
  available: boolean;
  servers: LspServerInfo[];
}

export interface LspServerInfo {
  name: string;
  status: "running" | "stopped" | "error";
  fileTypes: string[];
  error?: string;
}

/**
 * Check LSP availability by invoking the lsp tool's "status" action.
 * Uses pi.exec to call the lsp tool programmatically.
 */
export async function detectLsp(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>
): Promise<LspStatus> {
  try {
    // We check by looking for LSP config files or running servers
    // In OMP, LSP is a built-in tool — we check if it's in active tools
    return { available: false, servers: [] };
  } catch {
    return { available: false, servers: [] };
  }
}

/**
 * Check if LSP is available from the extension context.
 * Reads the active tools list to see if "lsp" is registered.
 */
export function isLspAvailable(activeTools: string[]): boolean {
  return activeTools.includes("lsp");
}
```

- [ ] **Step 2: Write LSP bridge**

```ts
// src/lsp/bridge.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface DiagnosticsResult {
  file: string;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  line: number;
  column: number;
}

/**
 * Request LSP diagnostics for a file by sending a message that
 * triggers the LLM to use the lsp tool. For direct use,
 * we provide a prompt snippet the orchestrator can include
 * in sub-agent assignments.
 */
export function buildLspDiagnosticsPrompt(files: string[]): string {
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return [
    "Run LSP diagnostics on these files and report any errors or warnings:",
    fileList,
    "",
    'Use the lsp tool with action "diagnostics" for each file.',
    "Report the results in this format:",
    "FILE: <path>",
    "  LINE:COL SEVERITY: message",
  ].join("\n");
}

/**
 * Build a prompt snippet for sub-agents to check references before renaming.
 */
export function buildLspReferencesPrompt(symbol: string, file: string): string {
  return [
    `Before modifying "${symbol}" in ${file}, use the lsp tool:`,
    `1. action: "references", file: "${file}", symbol: "${symbol}"`,
    "2. Review all references to understand impact",
    "3. Update all references as part of your changes",
  ].join("\n");
}

/**
 * Build a prompt for post-edit validation via LSP.
 */
export function buildLspValidationPrompt(files: string[]): string {
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return [
    "After making your changes, validate with LSP:",
    fileList,
    "",
    'Use the lsp tool with action "diagnostics" on each changed file.',
    "If there are errors, fix them before reporting completion.",
  ].join("\n");
}
```

- [ ] **Step 3: Write LSP setup guide**

```ts
// src/lsp/setup-guide.ts

export interface SetupInstruction {
  language: string;
  server: string;
  installCommand: string;
  notes: string;
}

const COMMON_LSP_SERVERS: SetupInstruction[] = [
  {
    language: "TypeScript/JavaScript",
    server: "typescript-language-server",
    installCommand: "bun add -g typescript-language-server typescript",
    notes: "Requires a tsconfig.json in your project root.",
  },
  {
    language: "Python",
    server: "pyright",
    installCommand: "pip install pyright",
    notes: "Works best with a pyrightconfig.json or pyproject.toml.",
  },
  {
    language: "Rust",
    server: "rust-analyzer",
    installCommand: "rustup component add rust-analyzer",
    notes: "Requires a Cargo.toml project.",
  },
  {
    language: "Go",
    server: "gopls",
    installCommand: "go install golang.org/x/tools/gopls@latest",
    notes: "Requires a go.mod project.",
  },
];

/** Get setup instructions for detected project languages */
export function getSetupInstructions(detectedLanguages: string[]): SetupInstruction[] {
  return COMMON_LSP_SERVERS.filter((s) =>
    detectedLanguages.some((lang) =>
      s.language.toLowerCase().includes(lang.toLowerCase())
    )
  );
}

/** Detect project languages from file extensions */
export function detectProjectLanguages(files: string[]): string[] {
  const extMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
  };
  const languages = new Set<string>();
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf("."));
    if (extMap[ext]) languages.add(extMap[ext]);
  }
  return [...languages];
}

/** Format setup instructions as readable text */
export function formatSetupGuide(instructions: SetupInstruction[]): string {
  if (instructions.length === 0) {
    return "No LSP setup instructions available for your project languages.";
  }
  const lines = ["LSP Setup Guide:", ""];
  for (const inst of instructions) {
    lines.push(`## ${inst.language} — ${inst.server}`);
    lines.push(`Install: ${inst.installCommand}`);
    lines.push(`Note: ${inst.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Write LSP detector tests**

```ts
// tests/lsp/detector.test.ts
import { describe, test, expect } from "vitest";
import { isLspAvailable } from "../../src/lsp/detector.js";
import { detectProjectLanguages, getSetupInstructions } from "../../src/lsp/setup-guide.js";
import { buildLspDiagnosticsPrompt } from "../../src/lsp/bridge.js";

describe("isLspAvailable", () => {
  test("returns true when lsp is in active tools", () => {
    expect(isLspAvailable(["read", "write", "lsp", "bash"])).toBe(true);
  });

  test("returns false when lsp is not in active tools", () => {
    expect(isLspAvailable(["read", "write", "bash"])).toBe(false);
  });
});

describe("detectProjectLanguages", () => {
  test("detects typescript from .ts files", () => {
    const langs = detectProjectLanguages(["src/index.ts", "src/types.ts"]);
    expect(langs).toContain("typescript");
  });

  test("detects multiple languages", () => {
    const langs = detectProjectLanguages(["app.py", "main.go", "index.ts"]);
    expect(langs).toContain("python");
    expect(langs).toContain("go");
    expect(langs).toContain("typescript");
  });
});

describe("getSetupInstructions", () => {
  test("returns instructions for detected languages", () => {
    const instructions = getSetupInstructions(["typescript"]);
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions[0].language).toContain("TypeScript");
  });
});

describe("buildLspDiagnosticsPrompt", () => {
  test("includes all files in prompt", () => {
    const prompt = buildLspDiagnosticsPrompt(["src/a.ts", "src/b.ts"]);
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toContain("diagnostics");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun run test -- tests/lsp/detector.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lsp/ tests/lsp/
git commit -m "feat: add LSP integration layer with detection, bridge, and setup guide"
```

---

### Task 7: Extension Entry Point & Base Commands

**Files:**
- Create: `src/index.ts`
- Create: `src/commands/supi.ts`
- Create: `src/commands/config.ts`
- Create: `src/commands/status.ts`

- [ ] **Step 1: Write the /supi overview command**

```ts
// src/commands/supi.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { findActiveRun } from "../storage/runs.js";
import { loadLatestReport } from "../storage/reports.js";
import { listPlans } from "../storage/plans.js";

export function registerSupiCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi", {
    description: "Supipowers overview — show available commands and project status",
    async handler(_args, ctx) {
      const config = loadConfig(ctx.cwd);
      const activeRun = findActiveRun(ctx.cwd);
      const latestReport = loadLatestReport(ctx.cwd);
      const plans = listPlans(ctx.cwd);

      const lines: string[] = [
        "# Supipowers",
        "",
        "## Commands",
        "  /supi:plan     — Start collaborative planning",
        "  /supi:run      — Execute a plan with sub-agents",
        "  /supi:review   — Run quality gates",
        "  /supi:qa       — Run QA pipeline",
        "  /supi:release  — Release automation",
        "  /supi:config   — Manage configuration",
        "  /supi:status   — Check running tasks",
        "",
        "## Project Status",
        `  Profile: ${config.defaultProfile}`,
        `  Plans: ${plans.length}`,
        `  Active run: ${activeRun ? activeRun.id : "none"}`,
        `  Last review: ${latestReport ? `${latestReport.timestamp.slice(0, 10)} (${latestReport.passed ? "passed" : "failed"})` : "none"}`,
      ];

      pi.sendMessage({
        customType: "supi-overview",
        content: [{ type: "text", text: lines.join("\n") }],
        display: "inline",
      });
    },
  });
}
```

- [ ] **Step 2: Write the /supi:config command**

```ts
// src/commands/config.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, updateConfig } from "../config/loader.js";
import { listProfiles, resolveProfile } from "../config/profiles.js";
import { notifyInfo, notifySuccess } from "../notifications/renderer.js";

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:config", {
    description: "View and manage Supipowers configuration and profiles",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);

      if (!args || args.trim() === "") {
        // Show current config
        const profiles = listProfiles(ctx.cwd);
        const activeProfile = resolveProfile(ctx.cwd, config);

        const lines = [
          "# Supipowers Configuration",
          "",
          `Profile: ${config.defaultProfile}`,
          `Max parallel agents: ${config.orchestration.maxParallelAgents}`,
          `Max fix retries: ${config.orchestration.maxFixRetries}`,
          `Max nesting depth: ${config.orchestration.maxNestingDepth}`,
          `Model preference: ${config.orchestration.modelPreference}`,
          `LSP auto-detect: ${config.lsp.autoDetect}`,
          `Notification verbosity: ${config.notifications.verbosity}`,
          `QA framework: ${config.qa.framework ?? "not detected"}`,
          `Release pipeline: ${config.release.pipeline ?? "not configured"}`,
          "",
          `Available profiles: ${profiles.join(", ")}`,
          "",
          "To update: /supi:config set <key> <value>",
          "Example: /supi:config set orchestration.maxParallelAgents 5",
        ];

        pi.sendMessage({
          customType: "supi-config",
          content: [{ type: "text", text: lines.join("\n") }],
          display: "inline",
        });
        return;
      }

      // Handle "set key value"
      const setMatch = args.match(/^set\s+(\S+)\s+(.+)$/);
      if (setMatch) {
        const [, keyPath, rawValue] = setMatch;
        const keys = keyPath.split(".");
        let value: unknown = rawValue;

        // Parse value types
        if (rawValue === "true") value = true;
        else if (rawValue === "false") value = false;
        else if (rawValue === "null") value = null;
        else if (!isNaN(Number(rawValue))) value = Number(rawValue);

        // Build nested update object
        const update: Record<string, unknown> = {};
        let current = update;
        for (let i = 0; i < keys.length - 1; i++) {
          current[keys[i]] = {};
          current = current[keys[i]] as Record<string, unknown>;
        }
        current[keys[keys.length - 1]] = value;

        updateConfig(ctx.cwd, update);
        notifySuccess(ctx, "Config updated", `${keyPath} = ${rawValue}`);
        return;
      }

      notifyInfo(ctx, "Usage", "/supi:config or /supi:config set <key> <value>");
    },
  });
}
```

- [ ] **Step 3: Write the /supi:status command**

```ts
// src/commands/status.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { findActiveRun, loadAllAgentResults } from "../storage/runs.js";
import { notifyInfo } from "../notifications/renderer.js";

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:status", {
    description: "Check on running sub-agents and task progress",
    async handler(_args, ctx) {
      const activeRun = findActiveRun(ctx.cwd);

      if (!activeRun) {
        notifyInfo(ctx, "No active runs", "Use /supi:run to execute a plan");
        return;
      }

      const results = loadAllAgentResults(ctx.cwd, activeRun.id);
      const completedIds = new Set(results.map((r) => r.taskId));
      const totalTasks = activeRun.batches.reduce(
        (sum, b) => sum + b.taskIds.length,
        0
      );
      const completedCount = results.length;
      const doneCount = results.filter((r) => r.status === "done").length;
      const concernCount = results.filter((r) => r.status === "done_with_concerns").length;
      const blockedCount = results.filter((r) => r.status === "blocked").length;

      const currentBatch = activeRun.batches.find((b) => b.status !== "completed");

      const lines = [
        `# Run: ${activeRun.id}`,
        "",
        `Status: ${activeRun.status}`,
        `Plan: ${activeRun.planRef}`,
        `Profile: ${activeRun.profile}`,
        `Progress: ${completedCount}/${totalTasks} tasks`,
        "",
        `  Done: ${doneCount}`,
        `  With concerns: ${concernCount}`,
        `  Blocked: ${blockedCount}`,
        "",
        `Current batch: ${currentBatch ? `#${currentBatch.index} (${currentBatch.status})` : "none"}`,
      ];

      pi.sendMessage({
        customType: "supi-status",
        content: [{ type: "text", text: lines.join("\n") }],
        display: "inline",
      });
    },
  });
}
```

- [ ] **Step 4: Write extension entry point**

```ts
// src/index.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSupiCommand } from "./commands/supi.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";

export default function supipowers(pi: ExtensionAPI): void {
  // Register base commands
  registerSupiCommand(pi);
  registerConfigCommand(pi);
  registerStatusCommand(pi);

  // Session start: check LSP and show welcome
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("supipowers", "supi ready");
    }
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/commands/supi.ts src/commands/config.ts src/commands/status.ts
git commit -m "feat: add extension entry point with /supi, /supi:config, /supi:status commands"
```

---

## Chunk 3: Planning & Orchestrator

### Task 8: Planning Command & Skill

**Files:**
- Create: `src/commands/plan.ts`
- Create: `skills/planning/SKILL.md`

- [ ] **Step 1: Write /supi:plan command**

```ts
// src/commands/plan.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { savePlan } from "../storage/plans.js";
import { notifySuccess, notifyInfo } from "../notifications/renderer.js";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerPlanCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:plan", {
    description: "Start collaborative planning for a feature or task",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);

      // Load the planning skill content
      const skillPath = findSkillPath("planning");
      let skillContent = "";
      if (skillPath) {
        try {
          skillContent = fs.readFileSync(skillPath, "utf-8");
        } catch {
          // Skill file not found — proceed without it
        }
      }

      const isQuick = args?.startsWith("--quick");
      const quickDesc = isQuick ? args.replace("--quick", "").trim() : "";

      let prompt: string;
      if (isQuick && quickDesc) {
        prompt = [
          "Generate a concise implementation plan for the following task.",
          "Skip brainstorming — go straight to task breakdown.",
          "",
          `Task: ${quickDesc}`,
          "",
          "Format the plan as markdown with YAML frontmatter (name, created, tags).",
          "Each task should have: name, [parallel-safe] or [sequential] annotation,",
          "**files**, **criteria**, and **complexity** (small/medium/large).",
          "",
          skillContent ? "Follow these planning guidelines:\n" + skillContent : "",
          "",
          "After generating the plan, save it and confirm with the user.",
        ].join("\n");
      } else {
        prompt = [
          "You are starting a collaborative planning session with the user.",
          "",
          args ? `The user wants to plan: ${args}` : "Ask the user what they want to build or accomplish.",
          "",
          "Process:",
          "1. Understand the goal — ask clarifying questions (one at a time)",
          "2. Propose 2-3 approaches with trade-offs",
          "3. Generate a task breakdown once aligned",
          "",
          "Format the final plan as markdown with YAML frontmatter (name, created, tags).",
          "Each task: name, [parallel-safe] or [sequential] annotation,",
          "**files**, **criteria**, **complexity** (small/medium/large).",
          "",
          skillContent ? "Follow these planning guidelines:\n" + skillContent : "",
        ].join("\n");
      }

      // Deliver the planning prompt to the agent
      pi.sendMessage(
        {
          customType: "supi-plan-start",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );

      notifyInfo(ctx, "Planning started", args ? `Topic: ${args}` : "Describe what you want to build");
    },
  });
}

function findSkillPath(skillName: string): string | null {
  // Look for skill relative to the extension
  const candidates = [
    path.join(process.cwd(), "skills", skillName, "SKILL.md"),
    path.join(__dirname, "..", "..", "skills", skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
```

- [ ] **Step 2: Write planning skill**

```markdown
<!-- skills/planning/SKILL.md -->
---
name: planning
description: Guides collaborative planning and task breakdown for implementation
---

# Planning Skill

Guide the user through planning an implementation. This skill is loaded by `/supi:plan`.

## Process

1. **Understand**: Ask one clarifying question at a time. Prefer multiple choice.
2. **Propose**: Offer 2-3 approaches with trade-offs and your recommendation.
3. **Break down**: Generate bite-sized tasks with clear boundaries.

## Task Format

Each task must have:
- Name with parallelism: `[parallel-safe]` or `[sequential: depends on N]`
- **files**: Exact paths the agent will touch
- **criteria**: Acceptance criteria (testable)
- **complexity**: `small` | `medium` | `large`

## Plan Structure

Use this template:

```
---
name: <feature-name>
created: <YYYY-MM-DD>
tags: [<relevant>, <tags>]
---

# <Feature Name>

## Context
<What this plan accomplishes and why>

## Tasks

### 1. <Task name> [parallel-safe]
- **files**: src/path/to/file.ts
- **criteria**: <what success looks like>
- **complexity**: small
```

## Principles

- Each task should be completable in 2-10 minutes
- Tasks that touch different files are parallel-safe
- Tasks that depend on others' output are sequential
- Include test files in the files list
- Prefer small, focused tasks over large ones
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/plan.ts skills/planning/SKILL.md
git commit -m "feat: add /supi:plan command with planning skill"
```

---

### Task 9: Orchestrator — Batch Scheduler

**Files:**
- Create: `src/orchestrator/batch-scheduler.ts`
- Test: `tests/orchestrator/batch-scheduler.test.ts`

- [ ] **Step 1: Write batch scheduler**

```ts
// src/orchestrator/batch-scheduler.ts
import type { PlanTask, RunBatch } from "../types.js";

/**
 * Group plan tasks into execution batches.
 * Parallel-safe tasks with no pending dependencies run together.
 * Sequential tasks wait for their dependencies.
 */
export function scheduleBatches(
  tasks: PlanTask[],
  maxParallel: number
): RunBatch[] {
  const batches: RunBatch[] = [];
  const completed = new Set<number>();
  const remaining = new Set(tasks.map((t) => t.id));

  let batchIndex = 0;

  while (remaining.size > 0) {
    const ready: number[] = [];

    for (const task of tasks) {
      if (!remaining.has(task.id)) continue;

      if (task.parallelism.type === "parallel-safe") {
        ready.push(task.id);
      } else if (task.parallelism.type === "sequential") {
        const depsReady = task.parallelism.dependsOn.every((dep) =>
          completed.has(dep)
        );
        if (depsReady) ready.push(task.id);
      }

      if (ready.length >= maxParallel) break;
    }

    if (ready.length === 0) {
      // Deadlock: remaining tasks have unresolvable dependencies
      // Force the first remaining task into a batch
      const first = [...remaining][0];
      ready.push(first);
    }

    const batch: RunBatch = {
      index: batchIndex++,
      taskIds: ready.slice(0, maxParallel),
      status: "pending",
    };

    for (const id of batch.taskIds) {
      remaining.delete(id);
      completed.add(id);
    }

    batches.push(batch);
  }

  return batches;
}
```

- [ ] **Step 2: Write tests**

```ts
// tests/orchestrator/batch-scheduler.test.ts
import { describe, test, expect } from "vitest";
import { scheduleBatches } from "../../src/orchestrator/batch-scheduler.js";
import type { PlanTask } from "../../src/types.js";

function task(id: number, parallelism: PlanTask["parallelism"]): PlanTask {
  return {
    id,
    name: `task-${id}`,
    description: `Task ${id}`,
    files: [],
    criteria: "",
    complexity: "small",
    parallelism,
  };
}

describe("scheduleBatches", () => {
  test("groups parallel-safe tasks together", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "parallel-safe" }),
      task(3, { type: "parallel-safe" }),
    ];
    const batches = scheduleBatches(tasks, 3);
    expect(batches).toHaveLength(1);
    expect(batches[0].taskIds).toEqual([1, 2, 3]);
  });

  test("respects maxParallel limit", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "parallel-safe" }),
      task(3, { type: "parallel-safe" }),
    ];
    const batches = scheduleBatches(tasks, 2);
    expect(batches).toHaveLength(2);
    expect(batches[0].taskIds).toHaveLength(2);
    expect(batches[1].taskIds).toHaveLength(1);
  });

  test("sequential tasks wait for dependencies", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "sequential", dependsOn: [1] }),
      task(3, { type: "parallel-safe" }),
    ];
    const batches = scheduleBatches(tasks, 3);
    expect(batches).toHaveLength(2);
    expect(batches[0].taskIds).toContain(1);
    expect(batches[0].taskIds).toContain(3);
    expect(batches[0].taskIds).not.toContain(2);
    expect(batches[1].taskIds).toContain(2);
  });

  test("handles chain dependencies", () => {
    const tasks = [
      task(1, { type: "parallel-safe" }),
      task(2, { type: "sequential", dependsOn: [1] }),
      task(3, { type: "sequential", dependsOn: [2] }),
    ];
    const batches = scheduleBatches(tasks, 3);
    expect(batches).toHaveLength(3);
    expect(batches[0].taskIds).toEqual([1]);
    expect(batches[1].taskIds).toEqual([2]);
    expect(batches[2].taskIds).toEqual([3]);
  });

  test("handles deadlock by forcing first remaining", () => {
    const tasks = [
      task(1, { type: "sequential", dependsOn: [2] }),
      task(2, { type: "sequential", dependsOn: [1] }),
    ];
    const batches = scheduleBatches(tasks, 2);
    // Should not hang — forces progress
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- tests/orchestrator/batch-scheduler.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/batch-scheduler.ts tests/orchestrator/batch-scheduler.test.ts
git commit -m "feat: add batch scheduler for parallel task grouping"
```

---

### Task 10: Orchestrator — Prompt Templates

**Files:**
- Create: `src/orchestrator/prompts.ts`

- [ ] **Step 1: Write prompt templates**

```ts
// src/orchestrator/prompts.ts
import type { PlanTask, SupipowersConfig } from "../types.js";
import { buildLspValidationPrompt } from "../lsp/bridge.js";

/** Build the system prompt for a sub-agent executing a task */
export function buildTaskPrompt(
  task: PlanTask,
  planContext: string,
  config: SupipowersConfig,
  lspAvailable: boolean
): string {
  const sections: string[] = [
    "# Task Assignment",
    "",
    `## Task: ${task.name}`,
    "",
    task.description,
    "",
    "## Target Files",
    ...task.files.map((f) => `- ${f}`),
    "",
    "## Acceptance Criteria",
    task.criteria,
    "",
    "## Context",
    planContext,
    "",
    "## Instructions",
    "1. Read the target files to understand current state",
    "2. Implement the changes described above",
    "3. Ensure acceptance criteria are met",
    "4. Report your status when done",
    "",
    "Report one of these statuses:",
    "- DONE: Task completed successfully, all criteria met",
    "- DONE_WITH_CONCERNS: Completed but with caveats (explain what)",
    "- BLOCKED: Cannot complete (explain why and what's needed)",
  ];

  if (lspAvailable) {
    sections.push(
      "",
      "## LSP Available",
      "You have access to the LSP tool. Use it to:",
      "- Check diagnostics after making changes",
      "- Find references before renaming symbols",
      "- Validate your work has no type errors",
      "",
      buildLspValidationPrompt(task.files)
    );
  }

  return sections.join("\n");
}

/** Build prompt for a fix agent */
export function buildFixPrompt(
  task: PlanTask,
  previousOutput: string,
  failureReason: string,
  lspAvailable: boolean
): string {
  const sections: string[] = [
    "# Fix Assignment",
    "",
    `## Original Task: ${task.name}`,
    "",
    "## What Went Wrong",
    failureReason,
    "",
    "## Previous Agent Output",
    previousOutput,
    "",
    "## Target Files",
    ...task.files.map((f) => `- ${f}`),
    "",
    "## Acceptance Criteria",
    task.criteria,
    "",
    "## Instructions",
    "1. Understand what the previous agent attempted",
    "2. Identify and fix the issue",
    "3. Verify the acceptance criteria are now met",
    "4. Report your status",
  ];

  if (lspAvailable) {
    sections.push("", buildLspValidationPrompt(task.files));
  }

  return sections.join("\n");
}

/** Build prompt for a merge/conflict resolution agent */
export function buildMergePrompt(
  conflictingFiles: string[],
  agentOutputs: { taskName: string; output: string }[]
): string {
  const sections: string[] = [
    "# Merge Assignment",
    "",
    "Multiple agents edited the same files. Resolve the conflicts.",
    "",
    "## Conflicting Files",
    ...conflictingFiles.map((f) => `- ${f}`),
    "",
    "## Agent Outputs",
  ];

  for (const { taskName, output } of agentOutputs) {
    sections.push(`### ${taskName}`, output, "");
  }

  sections.push(
    "## Instructions",
    "1. Read each conflicting file",
    "2. Understand what each agent intended",
    "3. Merge the changes so both intents are preserved",
    "4. If changes are incompatible, report BLOCKED with explanation"
  );

  return sections.join("\n");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator/prompts.ts
git commit -m "feat: add orchestrator prompt templates for task, fix, and merge agents"
```

---

### Task 11: Orchestrator — Dispatcher & Result Collector

**Files:**
- Create: `src/orchestrator/dispatcher.ts`
- Create: `src/orchestrator/result-collector.ts`
- Create: `src/orchestrator/conflict-resolver.ts`

- [ ] **Step 1: Write dispatcher**

```ts
// src/orchestrator/dispatcher.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PlanTask, AgentResult, AgentStatus, SupipowersConfig } from "../types.js";
import { buildTaskPrompt, buildFixPrompt } from "./prompts.js";
import { isLspAvailable } from "../lsp/detector.js";
import { notifySuccess, notifyWarning, notifyError } from "../notifications/renderer.js";

export interface DispatchOptions {
  pi: ExtensionAPI;
  ctx: { cwd: string; ui: { notify(msg: string, type?: "info" | "warning" | "error"): void } };
  task: PlanTask;
  planContext: string;
  config: SupipowersConfig;
  lspAvailable: boolean;
}

/** Dispatch a sub-agent for a single task */
export async function dispatchAgent(options: DispatchOptions): Promise<AgentResult> {
  const { pi, ctx, task, planContext, config, lspAvailable } = options;
  const startTime = Date.now();

  const prompt = buildTaskPrompt(task, planContext, config, lspAvailable);

  try {
    // Use OMP's sendMessage to trigger sub-agent execution
    // The actual sub-agent dispatch uses the task tool internally
    // For now, we use sendUserMessage to prompt the agent
    const result = await executeSubAgent(pi, prompt, task, config);

    const agentResult: AgentResult = {
      taskId: task.id,
      status: result.status,
      output: result.output,
      concerns: result.concerns,
      filesChanged: result.filesChanged,
      duration: Date.now() - startTime,
    };

    // Notify based on status
    switch (agentResult.status) {
      case "done":
        notifySuccess(ctx, `Task ${task.id} completed`, task.name);
        break;
      case "done_with_concerns":
        notifyWarning(ctx, `Task ${task.id} done with concerns`, agentResult.concerns);
        break;
      case "blocked":
        notifyError(ctx, `Task ${task.id} blocked`, agentResult.output);
        break;
    }

    return agentResult;
  } catch (error) {
    const agentResult: AgentResult = {
      taskId: task.id,
      status: "blocked",
      output: `Agent error: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [],
      duration: Date.now() - startTime,
    };
    notifyError(ctx, `Task ${task.id} failed`, agentResult.output);
    return agentResult;
  }
}

interface SubAgentResult {
  status: AgentStatus;
  output: string;
  concerns?: string;
  filesChanged: string[];
}

async function executeSubAgent(
  pi: ExtensionAPI,
  prompt: string,
  task: PlanTask,
  config: SupipowersConfig
): Promise<SubAgentResult> {
  // This will be implemented with OMP's createAgentSession API.
  // For now, provide a structure that can be filled in when we
  // have access to the full OMP runtime.
  //
  // The implementation will:
  // 1. Create an in-memory agent session
  // 2. Set tool access (read, write, edit, bash, lsp)
  // 3. Send the prompt
  // 4. Collect the result
  // 5. Parse the status from the agent's response

  throw new Error(
    "Sub-agent dispatch requires OMP runtime. " +
    "This will be connected to createAgentSession during integration."
  );
}

/** Dispatch a fix agent for a failed task */
export async function dispatchFixAgent(
  options: DispatchOptions & { previousOutput: string; failureReason: string }
): Promise<AgentResult> {
  const { pi, ctx, task, config, lspAvailable, previousOutput, failureReason } = options;
  const startTime = Date.now();

  const prompt = buildFixPrompt(task, previousOutput, failureReason, lspAvailable);

  try {
    const result = await executeSubAgent(pi, prompt, task, config);
    return {
      taskId: task.id,
      status: result.status,
      output: result.output,
      concerns: result.concerns,
      filesChanged: result.filesChanged,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      taskId: task.id,
      status: "blocked",
      output: `Fix agent error: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [],
      duration: Date.now() - startTime,
    };
  }
}
```

- [ ] **Step 2: Write result collector**

```ts
// src/orchestrator/result-collector.ts
import type { AgentResult, RunBatch } from "../types.js";

export interface BatchSummary {
  batchIndex: number;
  total: number;
  done: number;
  doneWithConcerns: number;
  blocked: number;
  allPassed: boolean;
  concerns: string[];
  blockers: string[];
  filesChanged: string[];
}

/** Summarize results for a batch */
export function summarizeBatch(
  batch: RunBatch,
  results: AgentResult[]
): BatchSummary {
  const batchResults = results.filter((r) => batch.taskIds.includes(r.taskId));

  const done = batchResults.filter((r) => r.status === "done").length;
  const doneWithConcerns = batchResults.filter(
    (r) => r.status === "done_with_concerns"
  ).length;
  const blocked = batchResults.filter((r) => r.status === "blocked").length;

  return {
    batchIndex: batch.index,
    total: batch.taskIds.length,
    done,
    doneWithConcerns,
    blocked,
    allPassed: blocked === 0,
    concerns: batchResults
      .filter((r) => r.concerns)
      .map((r) => r.concerns!),
    blockers: batchResults
      .filter((r) => r.status === "blocked")
      .map((r) => r.output),
    filesChanged: batchResults.flatMap((r) => r.filesChanged),
  };
}

/** Detect file conflicts within a batch (files changed by multiple agents) */
export function detectConflicts(results: AgentResult[]): string[] {
  const fileCounts = new Map<string, number>();
  for (const result of results) {
    for (const file of result.filesChanged) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  return [...fileCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file);
}

/** Build a final run summary */
export function buildRunSummary(allResults: AgentResult[]): {
  totalTasks: number;
  done: number;
  doneWithConcerns: number;
  blocked: number;
  totalFilesChanged: number;
  totalDuration: number;
} {
  return {
    totalTasks: allResults.length,
    done: allResults.filter((r) => r.status === "done").length,
    doneWithConcerns: allResults.filter((r) => r.status === "done_with_concerns").length,
    blocked: allResults.filter((r) => r.status === "blocked").length,
    totalFilesChanged: new Set(allResults.flatMap((r) => r.filesChanged)).size,
    totalDuration: allResults.reduce((sum, r) => sum + r.duration, 0),
  };
}
```

- [ ] **Step 3: Write conflict resolver**

```ts
// src/orchestrator/conflict-resolver.ts
import type { AgentResult, PlanTask } from "../types.js";
import { detectConflicts } from "./result-collector.js";
import { buildMergePrompt } from "./prompts.js";

export interface ConflictResolution {
  hasConflicts: boolean;
  conflictingFiles: string[];
  mergePrompt?: string;
}

/** Analyze batch results for file conflicts and prepare resolution */
export function analyzeConflicts(
  results: AgentResult[],
  tasks: PlanTask[]
): ConflictResolution {
  const conflictingFiles = detectConflicts(results);

  if (conflictingFiles.length === 0) {
    return { hasConflicts: false, conflictingFiles: [] };
  }

  // Build merge prompt with outputs from conflicting agents
  const conflictingResults = results.filter((r) =>
    r.filesChanged.some((f) => conflictingFiles.includes(f))
  );

  const agentOutputs = conflictingResults.map((r) => {
    const task = tasks.find((t) => t.id === r.taskId);
    return {
      taskName: task?.name ?? `Task ${r.taskId}`,
      output: r.output,
    };
  });

  return {
    hasConflicts: true,
    conflictingFiles,
    mergePrompt: buildMergePrompt(conflictingFiles, agentOutputs),
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/dispatcher.ts src/orchestrator/result-collector.ts src/orchestrator/conflict-resolver.ts
git commit -m "feat: add orchestrator dispatcher, result collector, and conflict resolver"
```

---

### Task 12: Run Command

**Files:**
- Create: `src/commands/run.ts`

- [ ] **Step 1: Write /supi:run command**

```ts
// src/commands/run.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { resolveProfile } from "../config/profiles.js";
import { listPlans, readPlanFile, parsePlan } from "../storage/plans.js";
import {
  generateRunId,
  createRun,
  updateRun,
  findActiveRun,
  saveAgentResult,
  loadAllAgentResults,
} from "../storage/runs.js";
import { scheduleBatches } from "../orchestrator/batch-scheduler.js";
import { dispatchAgent, dispatchFixAgent } from "../orchestrator/dispatcher.js";
import { summarizeBatch, buildRunSummary } from "../orchestrator/result-collector.js";
import { analyzeConflicts } from "../orchestrator/conflict-resolver.js";
import { isLspAvailable } from "../lsp/detector.js";
import {
  notifyInfo,
  notifySuccess,
  notifyWarning,
  notifyError,
  notifySummary,
} from "../notifications/renderer.js";
import type { RunManifest, AgentResult } from "../types.js";

export function registerRunCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:run", {
    description: "Execute a plan with sub-agent orchestration",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);
      const profile = resolveProfile(ctx.cwd, config, args?.replace("--profile ", "") || undefined);

      // Check for active run to resume
      let manifest = findActiveRun(ctx.cwd);

      if (!manifest) {
        // Find the plan to execute
        const plans = listPlans(ctx.cwd);
        if (plans.length === 0) {
          notifyError(ctx, "No plans found", "Run /supi:plan first to create a plan");
          return;
        }

        const planName = args?.trim() || plans[0];
        const planContent = readPlanFile(ctx.cwd, planName);
        if (!planContent) {
          notifyError(ctx, "Plan not found", planName);
          return;
        }

        const plan = parsePlan(planContent, planName);
        const batches = scheduleBatches(plan.tasks, config.orchestration.maxParallelAgents);

        manifest = {
          id: generateRunId(),
          planRef: planName,
          profile: profile.name,
          status: "running",
          startedAt: new Date().toISOString(),
          batches,
        };
        createRun(ctx.cwd, manifest);
        notifyInfo(ctx, `Run started: ${manifest.id}`, `${plan.tasks.length} tasks in ${batches.length} batches`);
      } else {
        notifyInfo(ctx, `Resuming run: ${manifest.id}`);
      }

      // Find the plan content for context
      const planContent = readPlanFile(ctx.cwd, manifest.planRef);
      if (!planContent) {
        notifyError(ctx, "Plan file missing", manifest.planRef);
        return;
      }
      const plan = parsePlan(planContent, manifest.planRef);
      const lsp = isLspAvailable(pi.getActiveTools());

      // Execute batches
      for (const batch of manifest.batches) {
        if (batch.status === "completed") continue;

        batch.status = "running";
        updateRun(ctx.cwd, manifest);

        notifyInfo(
          ctx,
          `Batch ${batch.index + 1}/${manifest.batches.length}`,
          `${batch.taskIds.length} tasks`
        );

        // Dispatch agents for this batch
        const batchResults: AgentResult[] = [];
        const agentPromises = batch.taskIds.map((taskId) => {
          const task = plan.tasks.find((t) => t.id === taskId);
          if (!task) return Promise.resolve(null);

          return dispatchAgent({
            pi,
            ctx,
            task,
            planContext: plan.context,
            config,
            lspAvailable: lsp,
          });
        });

        const results = await Promise.all(agentPromises);
        for (const result of results) {
          if (result) {
            batchResults.push(result);
            saveAgentResult(ctx.cwd, manifest.id, result);
          }
        }

        // Check for conflicts
        const conflicts = analyzeConflicts(batchResults, plan.tasks);
        if (conflicts.hasConflicts) {
          notifyWarning(
            ctx,
            "File conflicts detected",
            conflicts.conflictingFiles.join(", ")
          );
          // TODO: dispatch merge agent when OMP runtime available
        }

        // Handle failures with fix agents
        const failedResults = batchResults.filter((r) => r.status === "blocked");
        for (const failed of failedResults) {
          if (config.orchestration.maxFixRetries > 0) {
            const task = plan.tasks.find((t) => t.id === failed.taskId);
            if (!task) continue;

            for (let retry = 0; retry < config.orchestration.maxFixRetries; retry++) {
              notifyInfo(ctx, `Retrying task ${failed.taskId}`, `attempt ${retry + 1}`);
              const fixResult = await dispatchFixAgent({
                pi,
                ctx,
                task,
                planContext: plan.context,
                config,
                lspAvailable: lsp,
                previousOutput: failed.output,
                failureReason: failed.output,
              });
              saveAgentResult(ctx.cwd, manifest.id, fixResult);
              if (fixResult.status !== "blocked") break;
            }
          }
        }

        // Summarize batch
        const allResults = loadAllAgentResults(ctx.cwd, manifest.id);
        const summary = summarizeBatch(batch, allResults);

        batch.status = summary.allPassed ? "completed" : "failed";
        updateRun(ctx.cwd, manifest);

        if (!summary.allPassed) {
          notifyWarning(
            ctx,
            `Batch ${batch.index + 1} had issues`,
            `${summary.blocked} blocked, ${summary.doneWithConcerns} with concerns`
          );
        }
      }

      // Final summary
      const allResults = loadAllAgentResults(ctx.cwd, manifest.id);
      const runSummary = buildRunSummary(allResults);

      manifest.status = runSummary.blocked > 0 ? "failed" : "completed";
      manifest.completedAt = new Date().toISOString();
      updateRun(ctx.cwd, manifest);

      const durationSec = Math.round(runSummary.totalDuration / 1000);
      notifySummary(
        ctx,
        "Run complete",
        `${runSummary.done + runSummary.doneWithConcerns}/${runSummary.totalTasks} tasks done ` +
        `(${runSummary.done} clean, ${runSummary.doneWithConcerns} with concerns, ` +
        `${runSummary.blocked} blocked) | ${runSummary.totalFilesChanged} files | ${durationSec}s`
      );
    },
  });
}
```

- [ ] **Step 2: Register in index.ts**

Update `src/index.ts` to import and register the new commands:

```ts
// Add to src/index.ts imports:
import { registerPlanCommand } from "./commands/plan.js";
import { registerRunCommand } from "./commands/run.js";

// Add to registration block:
registerPlanCommand(pi);
registerRunCommand(pi);
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/run.ts src/index.ts
git commit -m "feat: add /supi:run command with full orchestration loop"
```

---

## Chunk 4: Quality Gates & Review Command

### Task 13: Quality Gates

**Files:**
- Create: `src/quality/gate-runner.ts`
- Create: `src/quality/lsp-gate.ts`
- Create: `src/quality/ai-review-gate.ts`
- Create: `src/quality/test-gate.ts`
- Test: `tests/quality/gate-runner.test.ts`

- [ ] **Step 1: Write LSP gate**

```ts
// src/quality/lsp-gate.ts
import type { GateResult } from "../types.js";

/**
 * LSP diagnostics gate.
 * Generates a prompt for the agent to run LSP diagnostics
 * and parse the results.
 */
export function buildLspGatePrompt(changedFiles: string[]): string {
  return [
    "Run LSP diagnostics on these files and report results:",
    ...changedFiles.map((f) => `- ${f}`),
    "",
    'Use the lsp tool with action "diagnostics" for each file.',
    "Summarize: total errors, total warnings, and list each issue.",
  ].join("\n");
}

/** Parse LSP gate result from agent response (simplified) */
export function createLspGateResult(
  hasErrors: boolean,
  errorCount: number,
  warningCount: number,
  issues: { severity: "error" | "warning" | "info"; message: string; file?: string; line?: number }[]
): GateResult {
  return {
    gate: "lsp-diagnostics",
    passed: !hasErrors,
    issues,
  };
}
```

- [ ] **Step 2: Write AI review gate**

```ts
// src/quality/ai-review-gate.ts
import type { GateResult } from "../types.js";

/** Build prompt for AI code review */
export function buildAiReviewPrompt(
  changedFiles: string[],
  depth: "quick" | "deep"
): string {
  const depthInstructions =
    depth === "quick"
      ? "Do a quick scan: check for obvious bugs, security issues, and naming problems."
      : [
          "Do a thorough review covering:",
          "- Correctness and edge cases",
          "- Security vulnerabilities (OWASP top 10)",
          "- Performance concerns",
          "- Code clarity and maintainability",
          "- Error handling completeness",
          "- Test coverage gaps",
        ].join("\n");

  return [
    "Review the following changed files:",
    ...changedFiles.map((f) => `- ${f}`),
    "",
    depthInstructions,
    "",
    "For each issue found, report:",
    "- Severity: error | warning | info",
    "- File and line number",
    "- Description of the issue",
    "- Suggested fix",
  ].join("\n");
}

/** Create gate result from parsed review */
export function createAiReviewResult(
  issues: { severity: "error" | "warning" | "info"; message: string; file?: string; line?: number }[]
): GateResult {
  const hasErrors = issues.some((i) => i.severity === "error");
  return {
    gate: "ai-review",
    passed: !hasErrors,
    issues,
  };
}
```

- [ ] **Step 3: Write test gate**

```ts
// src/quality/test-gate.ts
import type { GateResult } from "../types.js";

/** Build prompt to run test suite */
export function buildTestGatePrompt(
  testCommand: string | null,
  changedOnly: boolean,
  changedFiles?: string[]
): string {
  const cmd = testCommand ?? "npm test";
  const scope = changedOnly && changedFiles
    ? `Only run tests related to: ${changedFiles.join(", ")}`
    : "Run the full test suite.";

  return [
    scope,
    "",
    `Command: ${cmd}`,
    "",
    "Report the results:",
    "- Total tests, passed, failed, skipped",
    "- For each failure: test name, file, error message",
  ].join("\n");
}

/** Create gate result from test execution */
export function createTestGateResult(
  passed: boolean,
  totalTests: number,
  failedTests: number,
  failures: { message: string; file?: string }[]
): GateResult {
  return {
    gate: "test-suite",
    passed,
    issues: failures.map((f) => ({
      severity: "error" as const,
      message: `Test failed: ${f.message}`,
      file: f.file,
    })),
  };
}
```

- [ ] **Step 4: Write gate runner**

```ts
// src/quality/gate-runner.ts
import type { Profile, GateResult, ReviewReport } from "../types.js";
import { buildLspGatePrompt } from "./lsp-gate.js";
import { buildAiReviewPrompt } from "./ai-review-gate.js";
import { buildTestGatePrompt } from "./test-gate.js";

export interface GateRunnerOptions {
  profile: Profile;
  changedFiles: string[];
  testCommand: string | null;
  lspAvailable: boolean;
}

/** Determine which gates to run based on profile */
export function getActiveGates(profile: Profile, lspAvailable: boolean): string[] {
  const gates: string[] = [];
  if (profile.gates.lspDiagnostics && lspAvailable) gates.push("lsp-diagnostics");
  if (profile.gates.aiReview.enabled) gates.push("ai-review");
  if (profile.gates.codeQuality) gates.push("code-quality");
  if (profile.gates.testSuite) gates.push("test-suite");
  if (profile.gates.e2e) gates.push("e2e");
  return gates;
}

/** Build a combined review prompt for all active gates */
export function buildReviewPrompt(options: GateRunnerOptions): string {
  const { profile, changedFiles, testCommand, lspAvailable } = options;
  const sections: string[] = [
    "# Code Review",
    "",
    `Profile: ${profile.name}`,
    "",
    "Run the following quality checks and report results for each:",
    "",
  ];

  if (profile.gates.lspDiagnostics && lspAvailable) {
    sections.push("## 1. LSP Diagnostics", buildLspGatePrompt(changedFiles), "");
  }

  if (profile.gates.aiReview.enabled) {
    sections.push(
      "## 2. Code Review",
      buildAiReviewPrompt(changedFiles, profile.gates.aiReview.depth),
      ""
    );
  }

  if (profile.gates.testSuite) {
    sections.push(
      "## 3. Test Suite",
      buildTestGatePrompt(testCommand, false),
      ""
    );
  }

  return sections.join("\n");
}

/** Create a review report from gate results */
export function createReviewReport(
  profile: string,
  gates: GateResult[]
): ReviewReport {
  return {
    profile,
    timestamp: new Date().toISOString(),
    gates,
    passed: gates.every((g) => g.passed),
  };
}
```

- [ ] **Step 5: Write gate runner tests**

```ts
// tests/quality/gate-runner.test.ts
import { describe, test, expect } from "vitest";
import { getActiveGates, createReviewReport } from "../../src/quality/gate-runner.js";
import { BUILTIN_PROFILES } from "../../src/config/defaults.js";

describe("getActiveGates", () => {
  test("quick profile enables lsp and ai-review only", () => {
    const gates = getActiveGates(BUILTIN_PROFILES["quick"], true);
    expect(gates).toContain("lsp-diagnostics");
    expect(gates).toContain("ai-review");
    expect(gates).not.toContain("test-suite");
  });

  test("full-regression enables all gates", () => {
    const gates = getActiveGates(BUILTIN_PROFILES["full-regression"], true);
    expect(gates).toContain("lsp-diagnostics");
    expect(gates).toContain("ai-review");
    expect(gates).toContain("code-quality");
    expect(gates).toContain("test-suite");
    expect(gates).toContain("e2e");
  });

  test("skips lsp gate when lsp not available", () => {
    const gates = getActiveGates(BUILTIN_PROFILES["thorough"], false);
    expect(gates).not.toContain("lsp-diagnostics");
    expect(gates).toContain("ai-review");
  });
});

describe("createReviewReport", () => {
  test("report passes when all gates pass", () => {
    const report = createReviewReport("quick", [
      { gate: "lsp", passed: true, issues: [] },
      { gate: "ai-review", passed: true, issues: [] },
    ]);
    expect(report.passed).toBe(true);
  });

  test("report fails when any gate fails", () => {
    const report = createReviewReport("thorough", [
      { gate: "lsp", passed: true, issues: [] },
      { gate: "ai-review", passed: false, issues: [{ severity: "error", message: "bug" }] },
    ]);
    expect(report.passed).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun run test -- tests/quality/gate-runner.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/quality/ tests/quality/
git commit -m "feat: add composable quality gates with profile-based selection"
```

---

### Task 14: Review Command

**Files:**
- Create: `src/commands/review.ts`

- [ ] **Step 1: Write /supi:review command**

```ts
// src/commands/review.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/loader.js";
import { resolveProfile } from "../config/profiles.js";
import { buildReviewPrompt } from "../quality/gate-runner.js";
import { isLspAvailable } from "../lsp/detector.js";
import { notifyInfo, notifyWarning } from "../notifications/renderer.js";

export function registerReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:review", {
    description: "Run quality gates at chosen depth (quick/thorough/full-regression)",
    async handler(args, ctx) {
      const config = loadConfig(ctx.cwd);

      // Parse profile override from args
      let profileOverride: string | undefined;
      if (args?.includes("--quick")) profileOverride = "quick";
      else if (args?.includes("--thorough")) profileOverride = "thorough";
      else if (args?.includes("--full")) profileOverride = "full-regression";
      else if (args?.includes("--profile")) {
        const match = args.match(/--profile\s+(\S+)/);
        if (match) profileOverride = match[1];
      }

      const profile = resolveProfile(ctx.cwd, config, profileOverride);
      const lsp = isLspAvailable(pi.getActiveTools());

      if (!lsp && profile.gates.lspDiagnostics) {
        notifyWarning(
          ctx,
          "LSP not available",
          "Review will continue without LSP diagnostics. Run /supi:config for setup."
        );
      }

      // Get changed files (git diff)
      let changedFiles: string[] = [];
      try {
        const result = await pi.exec("git", ["diff", "--name-only", "HEAD"], { cwd: ctx.cwd });
        if (result.exitCode === 0) {
          changedFiles = result.stdout
            .split("\n")
            .map((f) => f.trim())
            .filter((f) => f.length > 0);
        }
      } catch {
        // If git fails, we'll review without file filtering
      }

      if (changedFiles.length === 0) {
        // Also check staged files
        try {
          const result = await pi.exec("git", ["diff", "--name-only", "--cached"], { cwd: ctx.cwd });
          if (result.exitCode === 0) {
            changedFiles = result.stdout
              .split("\n")
              .map((f) => f.trim())
              .filter((f) => f.length > 0);
          }
        } catch {
          // continue without
        }
      }

      if (changedFiles.length === 0) {
        notifyInfo(ctx, "No changed files detected", "Reviewing all files in scope");
      }

      const reviewPrompt = buildReviewPrompt({
        profile,
        changedFiles,
        testCommand: config.qa.command,
        lspAvailable: lsp,
      });

      notifyInfo(ctx, `Review started`, `profile: ${profile.name}`);

      // Deliver review prompt to agent
      pi.sendMessage(
        {
          customType: "supi-review",
          content: [{ type: "text", text: reviewPrompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );
    },
  });
}
```

- [ ] **Step 2: Register in index.ts**

```ts
// Add to src/index.ts:
import { registerReviewCommand } from "./commands/review.js";
// In registration block:
registerReviewCommand(pi);
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/review.ts src/index.ts
git commit -m "feat: add /supi:review command with profile-based quality gates"
```

---

## Chunk 5: QA Pipeline & Release

### Task 15: QA Pipeline

**Files:**
- Create: `src/qa/detector.ts`
- Create: `src/qa/runner.ts`
- Create: `src/qa/playwright.ts`
- Create: `src/qa/report.ts`
- Create: `src/commands/qa.ts`
- Test: `tests/qa/detector.test.ts`

- [ ] **Step 1: Write framework detector**

```ts
// src/qa/detector.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { updateConfig, loadConfig } from "../config/loader.js";

export interface DetectedFramework {
  name: string;
  command: string;
}

const FRAMEWORK_SIGNATURES: { name: string; files: string[]; command: string }[] = [
  { name: "vitest", files: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"], command: "npx vitest run" },
  { name: "jest", files: ["jest.config.ts", "jest.config.js", "jest.config.mjs"], command: "npx jest" },
  { name: "mocha", files: [".mocharc.yml", ".mocharc.json", ".mocharc.js"], command: "npx mocha" },
  { name: "pytest", files: ["pytest.ini", "pyproject.toml", "conftest.py"], command: "pytest" },
  { name: "cargo-test", files: ["Cargo.toml"], command: "cargo test" },
  { name: "go-test", files: ["go.mod"], command: "go test ./..." },
];

/** Detect test framework from project files */
export function detectFramework(cwd: string): DetectedFramework | null {
  // Check package.json scripts first
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        // Detect framework from test script
        const testScript = pkg.scripts.test;
        for (const sig of FRAMEWORK_SIGNATURES) {
          if (testScript.includes(sig.name)) {
            return { name: sig.name, command: `npm test` };
          }
        }
        return { name: "npm-test", command: "npm test" };
      }
    } catch {
      // continue to file-based detection
    }
  }

  // File-based detection
  for (const sig of FRAMEWORK_SIGNATURES) {
    for (const file of sig.files) {
      if (fs.existsSync(path.join(cwd, file))) {
        return { name: sig.name, command: sig.command };
      }
    }
  }

  return null;
}

/** Detect and cache framework in config */
export function detectAndCache(cwd: string): DetectedFramework | null {
  const config = loadConfig(cwd);

  // Return cached if available
  if (config.qa.framework && config.qa.command) {
    return { name: config.qa.framework, command: config.qa.command };
  }

  // Detect and cache
  const detected = detectFramework(cwd);
  if (detected) {
    updateConfig(cwd, { qa: { framework: detected.name, command: detected.command } });
  }
  return detected;
}
```

- [ ] **Step 2: Write QA runner**

```ts
// src/qa/runner.ts

/** Build prompt to run tests */
export function buildQaRunPrompt(
  command: string,
  scope: "all" | "changed" | "e2e",
  changedFiles?: string[]
): string {
  const sections: string[] = ["# QA Pipeline", ""];

  switch (scope) {
    case "all":
      sections.push(`Run the full test suite: \`${command}\``);
      break;
    case "changed":
      sections.push(
        "Run tests related to changed files only:",
        ...(changedFiles ?? []).map((f) => `- ${f}`),
        "",
        `Base command: \`${command}\``,
        "Filter to only tests relevant to the files above."
      );
      break;
    case "e2e":
      sections.push(
        "Run end-to-end tests only.",
        "Use Playwright or the configured E2E framework.",
        "Command: `npx playwright test`"
      );
      break;
  }

  sections.push(
    "",
    "Report results in this format:",
    "- Total tests: N",
    "- Passed: N",
    "- Failed: N",
    "- Skipped: N",
    "",
    "For each failure, include:",
    "- Test name",
    "- File path",
    "- Error message",
    "- Stack trace (first 5 lines)"
  );

  return sections.join("\n");
}
```

- [ ] **Step 3: Write QA report**

```ts
// src/qa/report.ts
import * as fs from "node:fs";
import * as path from "node:path";

export interface QaReport {
  timestamp: string;
  framework: string;
  scope: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: { name: string; file: string; error: string }[];
}

/** Save a QA report */
export function saveQaReport(cwd: string, report: QaReport): string {
  const dir = path.join(cwd, ".omp", "supipowers", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `qa-${report.timestamp.slice(0, 10)}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + "\n");
  return filePath;
}
```

- [ ] **Step 4: Write /supi:qa command**

```ts
// src/commands/qa.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { detectAndCache } from "../qa/detector.js";
import { buildQaRunPrompt } from "../qa/runner.js";
import { notifyInfo, notifyError } from "../notifications/renderer.js";

export function registerQaCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:qa", {
    description: "Run QA pipeline (test suite, E2E)",
    async handler(args, ctx) {
      // Detect framework (cached after first run)
      const framework = detectAndCache(ctx.cwd);

      if (!framework) {
        notifyError(
          ctx,
          "No test framework detected",
          "Configure manually: /supi:config set qa.framework vitest && /supi:config set qa.command 'npx vitest run'"
        );
        return;
      }

      // Parse scope from args
      let scope: "all" | "changed" | "e2e" = "all";
      let changedFiles: string[] | undefined;

      if (args?.includes("--changed")) {
        scope = "changed";
        try {
          const result = await pi.exec("git", ["diff", "--name-only", "HEAD"], { cwd: ctx.cwd });
          if (result.exitCode === 0) {
            changedFiles = result.stdout.split("\n").filter((f) => f.trim().length > 0);
          }
        } catch {
          // fallback to all
          scope = "all";
        }
      } else if (args?.includes("--e2e")) {
        scope = "e2e";
      }

      notifyInfo(ctx, "QA started", `${framework.name} | scope: ${scope}`);

      const prompt = buildQaRunPrompt(framework.command, scope, changedFiles);

      pi.sendMessage(
        {
          customType: "supi-qa",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );
    },
  });
}
```

- [ ] **Step 5: Write detector tests**

```ts
// tests/qa/detector.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { detectFramework } from "../../src/qa/detector.js";

describe("detectFramework", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects vitest from config file", () => {
    fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}");
    const result = detectFramework(tmpDir);
    expect(result?.name).toBe("vitest");
  });

  test("detects from package.json test script", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    const result = detectFramework(tmpDir);
    expect(result?.name).toBe("vitest");
    expect(result?.command).toBe("npm test");
  });

  test("detects pytest", () => {
    fs.writeFileSync(path.join(tmpDir, "conftest.py"), "");
    const result = detectFramework(tmpDir);
    expect(result?.name).toBe("pytest");
  });

  test("returns null when nothing detected", () => {
    expect(detectFramework(tmpDir)).toBeNull();
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun run test -- tests/qa/detector.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/qa/ src/commands/qa.ts tests/qa/
git commit -m "feat: add QA pipeline with framework detection, runner, and /supi:qa command"
```

---

### Task 16: Release Automation

**Files:**
- Create: `src/release/analyzer.ts`
- Create: `src/release/notes.ts`
- Create: `src/release/publisher.ts`
- Create: `src/commands/release.ts`

- [ ] **Step 1: Write commit analyzer**

```ts
// src/release/analyzer.ts

/** Build prompt to analyze commits and suggest version bump */
export function buildAnalyzerPrompt(lastTag: string | null): string {
  const sinceArg = lastTag ? `${lastTag}..HEAD` : "HEAD~20..HEAD";
  return [
    "# Release Analysis",
    "",
    `Analyze commits since ${lastTag ?? "beginning"}.`,
    "",
    `Run: git log ${sinceArg} --oneline --no-decorate`,
    "",
    "Then determine:",
    "1. Version bump type: major (breaking changes), minor (new features), patch (fixes)",
    "2. Categorize commits: features, fixes, breaking changes, other",
    "3. Suggest the next version number",
    "",
    "Report in this format:",
    "- Current version: <from package.json or last tag>",
    "- Suggested bump: major|minor|patch",
    "- Next version: X.Y.Z",
    "- Changes summary: categorized list",
  ].join("\n");
}
```

- [ ] **Step 2: Write release notes generator**

```ts
// src/release/notes.ts

/** Build prompt to generate release notes */
export function buildNotesPrompt(version: string, lastTag: string | null): string {
  const sinceArg = lastTag ? `${lastTag}..HEAD` : "HEAD~20..HEAD";
  return [
    "# Generate Release Notes",
    "",
    `Version: ${version}`,
    "",
    `Run: git log ${sinceArg} --format="%h %s"`,
    "",
    "Generate release notes in this format:",
    "",
    `## ${version}`,
    "",
    "### Features",
    "- Description (commit hash)",
    "",
    "### Fixes",
    "- Description (commit hash)",
    "",
    "### Breaking Changes",
    "- Description (commit hash)",
    "",
    "Keep descriptions user-facing (not commit-message-level detail).",
  ].join("\n");
}
```

- [ ] **Step 3: Write publisher**

```ts
// src/release/publisher.ts

/** Build prompt to execute release */
export function buildPublishPrompt(
  version: string,
  pipeline: string | null
): string {
  const steps: string[] = [
    "# Publish Release",
    "",
    `Version: ${version}`,
    "",
    "Execute these steps (ask for confirmation before each):",
    "",
    "1. Update version in package.json",
    `2. git add package.json && git commit -m "release: v${version}"`,
    `3. git tag v${version}`,
  ];

  if (pipeline === "npm") {
    steps.push("4. npm publish");
  } else if (pipeline === "github") {
    steps.push(`4. gh release create v${version} --generate-notes`);
  } else {
    steps.push("4. Ask the user what publish step to run");
  }

  steps.push(
    "",
    "IMPORTANT: Ask for user confirmation before tagging and publishing.",
    "Show them the version, changelog, and what will be published."
  );

  return steps.join("\n");
}
```

- [ ] **Step 4: Write /supi:release command**

```ts
// src/commands/release.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, updateConfig } from "../config/loader.js";
import { buildAnalyzerPrompt } from "../release/analyzer.js";
import { notifyInfo } from "../notifications/renderer.js";

export function registerReleaseCommand(pi: ExtensionAPI): void {
  pi.registerCommand("supi:release", {
    description: "Release automation — version bump, notes, publish",
    async handler(_args, ctx) {
      const config = loadConfig(ctx.cwd);

      // Get last tag
      let lastTag: string | null = null;
      try {
        const result = await pi.exec("git", ["describe", "--tags", "--abbrev=0"], { cwd: ctx.cwd });
        if (result.exitCode === 0) lastTag = result.stdout.trim();
      } catch {
        // no tags yet
      }

      // If no pipeline configured, ask on first run
      if (!config.release.pipeline) {
        const prompt = [
          "# Release Setup",
          "",
          "This is your first release with supipowers. How do you publish?",
          "",
          "1. **npm** — npm publish to registry",
          "2. **github** — GitHub Release with gh CLI",
          "3. **manual** — I'll handle publishing myself",
          "",
          "Tell me which option, and I'll save it for future releases.",
          "",
          "After you answer, I'll analyze commits and prepare the release.",
        ].join("\n");

        pi.sendMessage(
          {
            customType: "supi-release-setup",
            content: [{ type: "text", text: prompt }],
            display: "none",
          },
          { deliverAs: "steer" }
        );
        return;
      }

      notifyInfo(ctx, "Release started", `Pipeline: ${config.release.pipeline}`);

      const prompt = buildAnalyzerPrompt(lastTag);

      pi.sendMessage(
        {
          customType: "supi-release",
          content: [{ type: "text", text: prompt }],
          display: "none",
        },
        { deliverAs: "steer" }
      );
    },
  });
}
```

- [ ] **Step 5: Register all remaining commands in index.ts**

```ts
// Final src/index.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerSupiCommand } from "./commands/supi.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerRunCommand } from "./commands/run.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerQaCommand } from "./commands/qa.js";
import { registerReleaseCommand } from "./commands/release.js";

export default function supipowers(pi: ExtensionAPI): void {
  // Register all commands
  registerSupiCommand(pi);
  registerConfigCommand(pi);
  registerStatusCommand(pi);
  registerPlanCommand(pi);
  registerRunCommand(pi);
  registerReviewCommand(pi);
  registerQaCommand(pi);
  registerReleaseCommand(pi);

  // Session start
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("supipowers", "supi ready");
    }
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/release/ src/commands/release.ts src/index.ts
git commit -m "feat: add release automation with /supi:release command"
```

---

## Chunk 6: Skills & Final Integration

### Task 17: Skills

**Files:**
- Create: `skills/code-review/SKILL.md`
- Create: `skills/debugging/SKILL.md`
- Create: `skills/qa-strategy/SKILL.md`

- [ ] **Step 1: Write code review skill**

```markdown
<!-- skills/code-review/SKILL.md -->
---
name: code-review
description: Deep code review methodology for thorough quality assessment
---

# Code Review Skill

Systematic approach to reviewing code changes.

## Review Checklist

### Correctness
- Does the code do what it claims?
- Are edge cases handled?
- Are error conditions handled?

### Security
- Input validation at system boundaries?
- SQL injection, XSS, command injection risks?
- Secrets in code or logs?
- Authentication/authorization checks?

### Performance
- Unnecessary loops or allocations?
- N+1 query patterns?
- Missing indexes for frequent queries?
- Large payloads or unbounded lists?

### Maintainability
- Clear naming (functions, variables, files)?
- Single responsibility per unit?
- Unnecessary abstractions or premature optimization?
- Comments where logic isn't self-evident?

### Testing
- Tests cover the happy path?
- Tests cover error/edge cases?
- Tests are deterministic (no flaky tests)?
- Test names describe the behavior?

## Severity Levels

- **error**: Must fix before merge. Bugs, security issues, data loss risks.
- **warning**: Should fix. Code quality, maintainability, minor issues.
- **info**: Nice to have. Style, naming suggestions, minor improvements.
```

- [ ] **Step 2: Write debugging skill**

```markdown
<!-- skills/debugging/SKILL.md -->
---
name: debugging
description: Systematic debugging approach — investigate before fixing
---

# Debugging Skill

## Process

1. **Reproduce**: Can you reliably trigger the bug?
2. **Isolate**: What's the smallest input that triggers it?
3. **Investigate**: Read the relevant code. Trace the execution path.
4. **Hypothesize**: Form a theory about the root cause.
5. **Verify**: Add logging or a test that confirms the theory.
6. **Fix**: Make the minimal change that fixes the root cause.
7. **Validate**: Run the reproducer and existing tests.

## Rules

- Never guess-and-fix. Investigate first.
- After 3 failed fix attempts, step back and question your assumptions.
- Fix the root cause, not the symptom.
- Add a test that would have caught this bug.
```

- [ ] **Step 3: Write QA strategy skill**

```markdown
<!-- skills/qa-strategy/SKILL.md -->
---
name: qa-strategy
description: QA test planning for comprehensive coverage
---

# QA Strategy Skill

## Test Pyramid

1. **Unit tests**: Fast, isolated, cover individual functions
2. **Integration tests**: Test component interactions
3. **E2E tests**: Test user-facing flows end-to-end

## When to Write What

- New function → unit test
- New API endpoint → integration test
- New user flow → E2E test
- Bug fix → regression test at the appropriate level

## Coverage Priorities

Focus testing effort on:
1. Business logic (highest value)
2. Error handling paths
3. Edge cases in input validation
4. Integration points (API boundaries, DB queries)

Don't test:
- Framework boilerplate
- Simple getters/setters
- Third-party library behavior
```

- [ ] **Step 4: Commit**

```bash
git add skills/
git commit -m "feat: add code-review, debugging, and qa-strategy skills"
```

---

### Task 18: Final Integration & Smoke Test

- [ ] **Step 1: Run full test suite**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 3: Verify extension loads**

Create a test that validates the extension entry point:

```ts
// tests/integration/extension.test.ts
import { describe, test, expect, vi } from "vitest";
import supipowers from "../../src/index.js";

describe("extension entry point", () => {
  test("registers all commands without errors", () => {
    const registeredCommands: string[] = [];
    const mockPi = {
      registerCommand: vi.fn((name: string) => {
        registeredCommands.push(name);
      }),
      registerTool: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn(() => []),
      exec: vi.fn(),
    } as any;

    expect(() => supipowers(mockPi)).not.toThrow();

    expect(registeredCommands).toContain("supi");
    expect(registeredCommands).toContain("supi:plan");
    expect(registeredCommands).toContain("supi:run");
    expect(registeredCommands).toContain("supi:review");
    expect(registeredCommands).toContain("supi:qa");
    expect(registeredCommands).toContain("supi:release");
    expect(registeredCommands).toContain("supi:config");
    expect(registeredCommands).toContain("supi:status");
  });
});
```

- [ ] **Step 4: Run integration test**

Run: `bun run test -- tests/integration/extension.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/
git commit -m "feat: add integration smoke test for extension entry point"
```

- [ ] **Step 6: Final commit with all files verified**

Run: `git log --oneline`
Expected: Clean commit history showing the build-up of the extension
