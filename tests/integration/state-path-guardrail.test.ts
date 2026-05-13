// tests/integration/state-path-guardrail.test.ts
//
// Execution-state guardrail. The migration from local `<cwd>/.omp/supipowers/<dir>`
// paths to project-scoped global paths (`~/.omp/supipowers/projects/<slug>/<dir>`)
// is easy to regress: any future `paths.project(cwd, "<execution-segment>", …)` call
// puts per-invocation execution artifacts back in the local tree where two clones
// of the same repo would collide.
//
// This test scans `src/` and fails when any forbidden execution-state segment
// appears as the first segment passed to `paths.project(…)` (or `platform.paths.project(…)`
// and similar aliases). Team-shareable config segments (config.json, model.json,
// review-agents, …) are explicitly allowed.
//
// Regression class: execution state silently reintroduced into the committed
// `<cwd>/.omp/supipowers/` tree.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const FORBIDDEN_SEGMENTS = [
  "plans",
  "reviews",
  "reports",
  "fix-pr-sessions",
  "qa-sessions",
  "reliability",
  "debug",
  "visual",
  "ui-design",
  "sessions",
  "doc-drift.json",
] as const;

const repoRoot = process.cwd();
const SRC_DIR = path.join(repoRoot, "src");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && abs.endsWith(".ts") && !abs.endsWith(".d.ts")) {
        out.push(abs);
      }
    }
  }
  return out;
}

function stripComments(source: string): string {
  // Strip block comments.
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments, quote-aware so "//" inside strings is preserved.
  cleaned = cleaned
    .split("\n")
    .map((line) => {
      let inDouble = false;
      let inSingle = false;
      let inBacktick = false;
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const prev = line[i - 1];
        if (!inSingle && !inBacktick && c === '"' && prev !== "\\") inDouble = !inDouble;
        else if (!inDouble && !inBacktick && c === "'" && prev !== "\\") inSingle = !inSingle;
        else if (!inDouble && !inSingle && c === "`" && prev !== "\\") inBacktick = !inBacktick;
        if (!inDouble && !inSingle && !inBacktick && c === "/" && line[i + 1] === "/") {
          break;
        }
        out += c;
      }
      return out;
    })
    .join("\n");
  return cleaned;
}

describe("execution-state path guardrail", () => {
  test("no module reintroduces paths.project(cwd, <forbidden>, …) for execution state", () => {
    const offenders: string[] = [];
    // Matches: `<prefix>paths.project(<anything>, "<forbidden>"<rest>)`
    // where <forbidden> is one of the execution-state segments and
    // <prefix> captures optional qualifiers like `platform.` or similar.
    const segmentPattern = FORBIDDEN_SEGMENTS
      .map((s) => s.replace(/[.]/g, "\\$&"))
      .join("|");
    const callPattern = new RegExp(
      String.raw`\bpaths\.project\s*\(\s*[^,\)]+\s*,\s*["'](${segmentPattern})["']`,
      "g",
    );

    for (const file of walk(SRC_DIR)) {
      const rel = path.relative(repoRoot, file);
      // state-paths.ts is the canonical composer — it legitimately calls paths.project()
      // for the local helpers, and getProjectStatePath already composes on top of
      // paths.global(). Skip it from the scan.
      if (rel === path.join("src", "workspace", "state-paths.ts")) continue;
      const source = fs.readFileSync(file, "utf8");
      const stripped = stripComments(source);
      for (const match of stripped.matchAll(callPattern)) {
        offenders.push(`${rel}: paths.project(..., "${match[1]}")`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("tests do not create throwaway repositories or caches in the repo root", () => {
    const offenders: string[] = [];
    const testsDir = path.join(repoRoot, "tests");
    const forbiddenPatterns = [
      /createTestRepo\s*\(\s*process\.cwd\s*\(/,
      /createTestPaths\s*\(\s*process\.cwd\s*\(/,
      /path\.join\s*\(\s*process\.cwd\s*\(\s*\)\s*,\s*["'`](?:repo-|node-compile-cache|jest_dx)/,
      /mkdtempSync\s*\(\s*path\.join\s*\(\s*process\.cwd\s*\(\s*\)/,
    ];

    for (const file of walk(testsDir)) {
      const rel = path.relative(repoRoot, file);
      if (rel === path.join("tests", "integration", "state-path-guardrail.test.ts")) continue;
      const stripped = stripComments(fs.readFileSync(file, "utf8"));
      if (forbiddenPatterns.some((pattern) => pattern.test(stripped))) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
