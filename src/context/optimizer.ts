import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform } from "../platform/types.js";
import type { ParsedSkill, PromptSection } from "./analyzer.js";
import { estimateTokens } from "./analyzer.js";

// ── Types ───────────────────────────────────────────────────

export interface TechStack {
  languages: string[];
  frameworks: string[];
  tools: string[];
  runtime: string | null;
}

/** A skill with its token cost — no classification judgment. */
export interface SkillEntry {
  name: string;
  tokens: number;
}

/** A non-skill section with token cost and optional note. */
export interface SectionEntry {
  label: string;
  tokens: number;
  note: string;
}

/** Raw context report — data only, no classification. */
export interface ContextReport {
  totalTokens: number;
  techStack: TechStack;
  skills: SkillEntry[];
  sections: SectionEntry[];
}

// ── Framework / Tool Detection Maps ─────────────────────────

/** Maps package.json dependency names → detected framework or tool */
const DEP_TO_FRAMEWORK: Record<string, string> = {
  react: "react",
  "react-dom": "react",
  next: "next",
  vue: "vue",
  svelte: "svelte",
  "@sveltejs/kit": "svelte",
  express: "express",
  fastify: "fastify",
};

const DEP_TO_TOOL: Record<string, string> = {
  tailwindcss: "tailwind",
  "@playwright/test": "playwright",
  prisma: "prisma",
  "@prisma/client": "prisma",
  "@shadcn/ui": "shadcn",
};

// ── Tech Stack Detection ────────────────────────────────────

function tryReadFile(cwd: string, filename: string): string | null {
  try {
    return fs.readFileSync(path.join(cwd, filename), "utf8");
  } catch {
    return null;
  }
}

function fileExists(cwd: string, filename: string): boolean {
  try {
    return fs.statSync(path.join(cwd, filename)).isFile();
  } catch {
    return false;
  }
}

/**
 * Deterministic tech-stack detection — no LLM.
 * Inspects package.json, lockfiles, and config files.
 */
export async function detectTechStack(
  platform: Platform,
  cwd: string,
): Promise<TechStack> {
  void platform;

  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const tools = new Set<string>();
  let runtime: string | null = null;

  const pkgRaw = tryReadFile(cwd, "package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const allDeps: Record<string, string> = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      for (const dep of Object.keys(allDeps)) {
        const fw = DEP_TO_FRAMEWORK[dep];
        if (fw) frameworks.add(fw);
        const tl = DEP_TO_TOOL[dep];
        if (tl) tools.add(tl);
      }
      if (allDeps.typescript) languages.add("typescript");
    } catch {
      // malformed package.json — continue with file-based detection
    }
  }

  if (fileExists(cwd, "bun.lock")) {
    runtime = "bun";
  } else if (fileExists(cwd, "package-lock.json")) {
    runtime = "node";
  } else if (fileExists(cwd, "pnpm-lock.yaml")) {
    runtime = "node";
  } else if (fileExists(cwd, "yarn.lock")) {
    runtime = "node";
  }

  const configChecks: [string, string][] = [
    ["tsconfig.json", "typescript"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Gemfile", "ruby"],
  ];
  for (const [file, language] of configChecks) {
    if (fileExists(cwd, file)) {
      languages.add(language);
    }
  }

  return {
    languages: [...languages],
    frameworks: [...frameworks],
    tools: [...tools],
    runtime,
  };
}

// ── Context Report ──────────────────────────────────────────

/**
 * Build a raw context report from parsed prompt data.
 * Gathers token costs per skill and per section, flags anomalies.
 * Does NOT classify or recommend — that's the LLM's job.
 */
export function buildContextReport(
  sections: PromptSection[],
  skills: ParsedSkill[],
  techStack: TechStack,
): ContextReport {
  const totalTokens = sections.reduce(
    (sum, s) => sum + estimateTokens(s.content),
    0,
  );

  const skillEntries: SkillEntry[] = skills.map((s) => ({
    name: s.name,
    tokens: s.tokens,
  }));

  // Annotate non-skill sections with notes for anomalies
  const sectionEntries: SectionEntry[] = [];

  const routingSections = sections.filter((s) =>
    s.label.toLowerCase().includes("routing"),
  );
  const hasRoutingDupes = routingSections.length > 1;

  for (const s of sections) {
    // Skip the aggregate "Skills (N)" section — per-skill data is separate
    if (s.label.toLowerCase().startsWith("skills")) continue;

    const tokens = estimateTokens(s.content);
    let note = "";

    if (s.label.toLowerCase().includes("routing") && hasRoutingDupes) {
      note = `Duplicate (${routingSections.length} found) — consolidate`;
    } else if (s.label.toLowerCase().includes("memory") && tokens > 500) {
      note = "Large — consider compressing or summarizing";
    }

    sectionEntries.push({ label: s.label, tokens, note });
  }

  return { totalTokens, techStack, skills: skillEntries, sections: sectionEntries };
}
