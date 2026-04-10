import { describe, expect, mock, test } from "bun:test";
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

function mockPlatform(opts: {
  packageJson?: string | null;
  files?: Record<string, boolean>;
}) {
  const { packageJson, files = {} } = opts;
  return {
    exec: mock((cmd: string, args: string[]) => {
      if (cmd === "cat" && args[0] === "package.json") {
        return packageJson != null
          ? { code: 0, stdout: packageJson, stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (cmd === "test" && args[0] === "-f") {
        const filename = args[1];
        return { code: files[filename] ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    }),
  } as any;
}

// ── detectTechStack ─────────────────────────────────────────

describe("detectTechStack", () => {
  test("detects typescript and react from package.json", async () => {
    const pkg = JSON.stringify({
      dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    });
    const platform = mockPlatform({
      packageJson: pkg,
      files: { "tsconfig.json": true, "bun.lock": true },
    });
    const ts = await detectTechStack(platform, "/test");
    expect(ts.languages).toContain("typescript");
    expect(ts.frameworks).toContain("react");
    expect(ts.runtime).toBe("bun");
  });

  test("detects tools from devDependencies", async () => {
    const pkg = JSON.stringify({
      devDependencies: { tailwindcss: "^3.0.0", "@playwright/test": "^1.0.0" },
    });
    const platform = mockPlatform({ packageJson: pkg });
    const ts = await detectTechStack(platform, "/test");
    expect(ts.tools).toContain("tailwind");
    expect(ts.tools).toContain("playwright");
  });

  test("detects languages from config files", async () => {
    const platform = mockPlatform({
      packageJson: null,
      files: { "Cargo.toml": true, "go.mod": true },
    });
    const ts = await detectTechStack(platform, "/test");
    expect(ts.languages).toContain("rust");
    expect(ts.languages).toContain("go");
  });

  test("detects node runtime from package-lock.json", async () => {
    const platform = mockPlatform({
      packageJson: null,
      files: { "package-lock.json": true },
    });
    const ts = await detectTechStack(platform, "/test");
    expect(ts.runtime).toBe("node");
  });

  test("returns empty stacks when nothing detected", async () => {
    const platform = mockPlatform({ packageJson: null });
    const ts = await detectTechStack(platform, "/test");
    expect(ts.languages).toEqual([]);
    expect(ts.frameworks).toEqual([]);
    expect(ts.tools).toEqual([]);
    expect(ts.runtime).toBeNull();
  });

  test("handles malformed package.json gracefully", async () => {
    const platform = mockPlatform({ packageJson: "not json{" });
    const ts = await detectTechStack(platform, "/test");
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
    // Total includes the Skills aggregate section even though it's excluded from entries
    expect(report.totalTokens).toBe(
      Math.ceil(4000 / 4) + Math.ceil(2000 / 4),
    );
  });
});
