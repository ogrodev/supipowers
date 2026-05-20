import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const CROSS_PLATFORM_SKILL_REFERENCES_ROOT = path.join(
  REPO_ROOT,
  ".agents",
  "skills",
  "cross-platform-compatibility",
  "references",
);
const SKIPPED_DIRS = new Set(["node_modules"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const CHILD_PROCESS_IMPORT_ALLOWLIST = new Set([
  "src/commands/ultraplan.ts",
  "src/fix-pr/scripts/exec.ts",
  "src/mempalace/runtime.ts",
  "src/qa/scripts/dev-server-utils.ts",
  "src/qa/scripts/run-e2e-tests.ts",
  "src/qa/scripts/start-dev-server.ts",
]);

interface SourceLine {
  file: string;
  lineNumber: number;
  text: string;
}

function repoRelative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...walkSourceFiles(path.join(dir, entry.name)));
      }
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files.sort();
}

function sourceLines(): SourceLine[] {
  return walkSourceFiles(SRC_ROOT).flatMap((filePath) =>
    fs.readFileSync(filePath, "utf8").split("\n").map((text, index) => ({
      file: repoRelative(filePath),
      lineNumber: index + 1,
      text,
    })),
  );
}

function formatViolations(lines: SourceLine[]): string[] {
  return lines.map(({ file, lineNumber, text }) => `${file}:${lineNumber}: ${text.trim()}`);
}

function isAllowedPathSeparatorConcat({ file, text }: SourceLine): boolean {
  const trimmed = text.trim();
  if (file === "src/context-mode/source-hash.ts" && trimmed === 'return left + "/" + right;') {
    return true;
  }
  return file === "src/qa/discover-routes.ts" && trimmed.includes('.replace(/\\\\/g, "/")');
}

describe("cross-platform static hazards", () => {
  test("production code does not build filesystem paths by string-concatenating separators", () => {
    const separatorConcat = /\+\s*["'`]([/\\])["'`]\s*\+/;
    const violations = sourceLines().filter(
      (line) => separatorConcat.test(line.text) && !isAllowedPathSeparatorConcat(line),
    );

    expect(formatViolations(violations)).toEqual([]);
  });

  test("new direct child_process usage must be consciously allowlisted", () => {
    const childProcessImport = /from\s+["']node:child_process["']|require\(["']node:child_process["']\)/;
    const violations = sourceLines().filter(
      (line) => childProcessImport.test(line.text) && !CHILD_PROCESS_IMPORT_ALLOWLIST.has(line.file),
    );

    expect(formatViolations(violations)).toEqual([]);
  });

  test("package scripts avoid POSIX-only shell commands", () => {
    const packageJsonPath = path.join(REPO_ROOT, "package.json");
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const posixOnlyCommand = /(^|[;&|()\s])(bash|sh|rm|cp|mv|chmod|mkdir|grep|sed|awk|cat)(?=$|[;&|()\s])/;
    const violations = Object.entries(manifest.scripts ?? {})
      .filter(([, script]) => posixOnlyCommand.test(script))
      .map(([name, script]) => `${name}: ${script}`);

    expect(violations).toEqual([]);
  });

  test("cross-platform skill process docs expose taskkill failures to callers", () => {
    const processManagement = fs.readFileSync(
      path.join(CROSS_PLATFORM_SKILL_REFERENCES_ROOT, "process-management.md"),
      "utf8",
    );

    expect(processManagement).toContain(
      "static async kill(pid: number, signal?: string): Promise<void>",
    );
    expect(processManagement).toContain('await execFileAsync("taskkill"');
    expect(processManagement).not.toContain('proc.on("error"');
    expect(processManagement).not.toContain('proc.on("exit"');
  });

  test("cross-platform skill shell docs do not pass caller paths through cmd builtins", () => {
    const shellCommands = fs.readFileSync(
      path.join(CROSS_PLATFORM_SKILL_REFERENCES_ROOT, "shell-commands.md"),
      "utf8",
    );

    expect(shellCommands).toContain('import { readdir } from "fs/promises";');
    expect(shellCommands).toContain("const entries = await readdir(directory");
    expect(shellCommands).not.toContain('execFileAsync("cmd", ["/c", "dir", directory]');
    expect(shellCommands).not.toContain('execFileAsync("cmd", ["/c", "start"');
  });
});
