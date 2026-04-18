import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectTechStack,
  buildContextReport,
} from "../../src/context/optimizer.js";
import type {
  TechStack,
} from "../../src/context/optimizer.js";
import type { PromptSection, ParsedSkill } from "../../src/context/analyzer.js";

// ── Helpers ─────────────────────────────────────────────────

function section(label: string, size: number): PromptSection {
  return { label, bytes: size, content: "x".repeat(size) };
}

function skill(name: string, tokenSize: number = 500): ParsedSkill {
  const content = `## ${name}\n${"x".repeat(tokenSize * 4)}`;
  return {
    name,
    bytes: new TextEncoder().encode(content).length,
    tokens: Math.ceil(content.length / 4),
    content,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-context-optimizer-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ── detectTechStack ─────────────────────────────────────────

describe("detectTechStack", () => {
  test("detects typescript and react from package.json", async () => {
    writeFile("package.json", JSON.stringify({
      dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }));
    writeFile("tsconfig.json", "{}");
    writeFile("bun.lock", "lockfile");

    const ts = await detectTechStack({} as any, tmpDir);
    expect(ts.languages).toContain("typescript");
    expect(ts.frameworks).toContain("react");
    expect(ts.runtime).toBe("bun");
  });

  test("detects tools from devDependencies", async () => {
    writeFile("package.json", JSON.stringify({
      devDependencies: { tailwindcss: "^3.0.0", "@playwright/test": "^1.0.0" },
    }));

    const ts = await detectTechStack({} as any, tmpDir);
    expect(ts.tools).toContain("tailwind");
    expect(ts.tools).toContain("playwright");
  });

  test("detects languages from config files", async () => {
    writeFile("Cargo.toml", "[package]\nname = \"demo\"");
    writeFile("go.mod", "module demo");

    const ts = await detectTechStack({} as any, tmpDir);
    expect(ts.languages).toContain("rust");
    expect(ts.languages).toContain("go");
  });

  test("detects node runtime from package-lock.json", async () => {
    writeFile("package-lock.json", "{}");

    const ts = await detectTechStack({} as any, tmpDir);
    expect(ts.runtime).toBe("node");
  });

  test("returns empty stacks when nothing detected", async () => {
    const ts = await detectTechStack({} as any, tmpDir);
    expect(ts.languages).toEqual([]);
    expect(ts.frameworks).toEqual([]);
    expect(ts.tools).toEqual([]);
    expect(ts.runtime).toBeNull();
  });

  test("handles malformed package.json gracefully", async () => {
    writeFile("package.json", "not json{");

    const ts = await detectTechStack({} as any, tmpDir);
    expect(ts.languages).toEqual([]);
    expect(ts.frameworks).toEqual([]);
  });
});

// ── buildContextReport ──────────────────────────────────────

describe("buildContextReport", () => {
  const ts: TechStack = {
    languages: ["typescript"],
    frameworks: [],
    tools: [],
    runtime: "bun",
  };

  test("produces valid report structure", () => {
    const sections = [section("Base", 2000), section("Skills (2)", 4000)];
    const skills = [skill("planning"), skill("debugging")];
    const report = buildContextReport(sections, skills, ts);
    expect(report.totalTokens).toBeGreaterThan(0);
    expect(report.skills).toHaveLength(2);
    expect(report.techStack).toBe(ts);
  });

  test("reports per-skill token costs", () => {
    const skills = [skill("planning", 100), skill("debugging", 500)];
    const report = buildContextReport([section("Skills (2)", 3000)], skills, ts);
    expect(report.skills[0].name).toBe("planning");
    expect(report.skills[0].tokens).toBeGreaterThan(0);
    expect(report.skills[1].name).toBe("debugging");
    expect(report.skills[1].tokens).toBeGreaterThan(report.skills[0].tokens);
  });

  test("handles empty skills array", () => {
    const report = buildContextReport(
      [section("Base", 1000)],
      [],
      ts,
    );
    expect(report.skills).toHaveLength(0);
    expect(report.totalTokens).toBeGreaterThan(0);
  });

  test("flags duplicate routing blocks", () => {
    const sections = [
      section("Routing rules", 2000),
      section("Routing rules (duplicate)", 2000),
    ];
    const report = buildContextReport(sections, [], ts);
    const routingNotes = report.sections.filter((s) => s.note.includes("Duplicate"));
    expect(routingNotes.length).toBe(2);
  });

  test("flags large memory section", () => {
    const sections = [section("Memory", 4000)];
    const report = buildContextReport(sections, [], ts);
    const memEntry = report.sections.find((s) => s.label === "Memory");
    expect(memEntry).toBeDefined();
    expect(memEntry!.note).toContain("Large");
  });

  test("excludes aggregate Skills section from section entries", () => {
    const sections = [
      section("Skills (5)", 8000),
      section("Base", 2000),
    ];
    const report = buildContextReport(sections, [], ts);
    const skillSection = report.sections.find((s) => s.label.startsWith("Skills"));
    expect(skillSection).toBeUndefined();
  });

  test("totalTokens sums all sections including Skills aggregate", () => {
    const sections = [
      section("Skills (2)", 4000),
      section("Base", 2000),
    ];
    const report = buildContextReport(sections, [], ts);
    expect(report.totalTokens).toBe(
      Math.ceil(4000 / 4) + Math.ceil(2000 / 4),
    );
  });
});
