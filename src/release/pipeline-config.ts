import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReleasePreset = "node" | "python" | "rust" | "go" | "generic";

export interface ReleaseCommandSpec {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface ReleasePipelineConfig {
  preset: ReleasePreset;
  tagFormat: string;
  filesToStage: string[];
  validate: ReleaseCommandSpec[];
  versionBump: ReleaseCommandSpec;
  commit: ReleaseCommandSpec;
  tag: ReleaseCommandSpec;
  push: ReleaseCommandSpec[];
  release?: ReleaseCommandSpec;
}

export interface TemplateContext {
  version: string;
  tag: string;
}

const PIPELINE_DIR = [".pi", "supipowers"];
const PIPELINE_FILE = "release.pipeline.json";

export function releasePipelinePath(cwd: string): string {
  return join(cwd, ...PIPELINE_DIR, PIPELINE_FILE);
}

export function hasReleasePipeline(cwd: string): boolean {
  return existsSync(releasePipelinePath(cwd));
}

export function loadReleasePipeline(cwd: string): ReleasePipelineConfig | undefined {
  const path = releasePipelinePath(cwd);
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ReleasePipelineConfig;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (!parsed.versionBump || !parsed.commit || !parsed.tag) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveReleasePipeline(cwd: string, config: ReleasePipelineConfig): string {
  const dir = join(cwd, ...PIPELINE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = releasePipelinePath(cwd);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return path;
}

export function detectReleasePreset(cwd: string): ReleasePreset {
  if (existsSync(join(cwd, "package.json"))) return "node";
  if (existsSync(join(cwd, "pyproject.toml"))) return "python";
  if (existsSync(join(cwd, "Cargo.toml"))) return "rust";
  if (existsSync(join(cwd, "go.mod"))) return "go";
  return "generic";
}

function genericTemplate(preset: Exclude<ReleasePreset, "node">): ReleasePipelineConfig {
  return {
    preset,
    tagFormat: "v{version}",
    filesToStage: ["CHANGELOG.md"],
    validate: [],
    versionBump: {
      command: "echo",
      args: [`No automatic version bump configured for ${preset}. Update files manually before release {version}.`],
    },
    commit: {
      command: "git",
      args: ["commit", "-m", "chore(release): {tag}"],
    },
    tag: {
      command: "git",
      args: ["tag", "{tag}"],
    },
    push: [
      { command: "git", args: ["push", "origin", "main"] },
      { command: "git", args: ["push", "origin", "{tag}"] },
    ],
    release: {
      command: "gh",
      args: ["release", "create", "{tag}", "--title", "{tag}", "--notes-file", "CHANGELOG.md"],
    },
  };
}

export function releasePipelineTemplate(preset: ReleasePreset): ReleasePipelineConfig {
  if (preset === "node") {
    return {
      preset,
      tagFormat: "v{version}",
      filesToStage: ["package.json", "package-lock.json", "CHANGELOG.md"],
      validate: [
        { command: "npm", args: ["run", "typecheck"] },
        { command: "npm", args: ["test"] },
        { command: "npm", args: ["run", "build"] },
        { command: "npm", args: ["pack", "--dry-run"] },
      ],
      versionBump: {
        command: "npm",
        args: ["version", "{version}", "--no-git-tag-version"],
      },
      commit: {
        command: "git",
        args: ["commit", "-m", "chore(release): {tag}"],
      },
      tag: {
        command: "git",
        args: ["tag", "{tag}"],
      },
      push: [
        { command: "git", args: ["push", "origin", "main"] },
        { command: "git", args: ["push", "origin", "{tag}"] },
      ],
      release: {
        command: "gh",
        args: ["release", "create", "{tag}", "--title", "{tag}", "--notes-file", "CHANGELOG.md"],
      },
    };
  }

  return genericTemplate(preset);
}

export function fillTemplate(value: string, context: TemplateContext): string {
  return value
    .replaceAll("{version}", context.version)
    .replaceAll("{tag}", context.tag);
}

export function fillCommand(spec: ReleaseCommandSpec, context: TemplateContext): ReleaseCommandSpec {
  return {
    command: fillTemplate(spec.command, context),
    args: spec.args.map((arg) => fillTemplate(arg, context)),
    timeoutMs: spec.timeoutMs,
  };
}

export function formatTag(config: ReleasePipelineConfig, version: string): string {
  return fillTemplate(config.tagFormat || "v{version}", {
    version,
    tag: `v${version}`,
  });
}
