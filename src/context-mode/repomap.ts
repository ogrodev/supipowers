import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform } from "../platform/types.js";

export interface RepoMapOptions {
  cwd: string;
  focus?: string[];
  tokenBudget?: number;
  maxFiles?: number;
}

export interface RepoMapResult {
  text: string;
  fileCount: number;
  emittedBytes: number;
  consideredFiles: number;
}

const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_MAX_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const PAGERANK_ITERATIONS = 16;
const PAGERANK_DAMPING = 0.85;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".br",
  ".sqlite", ".db", ".lock", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".webm",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rb", ".rs", ".go", ".java", ".kt", ".swift", ".cs", ".php", ".lua",
  ".vue", ".svelte", ".astro",
]);

interface CandidateFile {
  relPath: string;
  absPath: string;
  size: number;
}

interface RepoMapEntry {
  file: string;
  symbols: string[];
  imports: string[];
  resolvedImports: string[];
  baseScore: number;
  rank: number;
  finalScore: number;
}

export async function buildRepoMap(platform: Platform, opts: RepoMapOptions): Promise<RepoMapResult> {
  const cwd = opts.cwd;
  const tokenBudget = normalizePositiveInteger(opts.tokenBudget, DEFAULT_TOKEN_BUDGET);
  const maxFiles = normalizePositiveInteger(opts.maxFiles, DEFAULT_MAX_FILES);
  const budgetBytes = tokenBudget * 4;
  const tokenignore = loadTokenignore(cwd);
  const focus = new Set((opts.focus ?? []).map(normalizePath));

  const candidates = await listCandidateFiles(platform, cwd, tokenignore);
  const fileSet = new Set(candidates.map((file) => file.relPath));

  const entries: RepoMapEntry[] = [];
  for (const candidate of candidates) {
    if (entries.length >= maxFiles) break;
    const entry = summarizeFile(candidate, fileSet);
    if (entry) entries.push(entry);
  }

  applyPageRank(entries, focus);
  entries.sort((a, b) => b.finalScore - a.finalScore || a.file.localeCompare(b.file));

  const headerLines = [
    "# Repository map",
    "",
    `Files considered: ${candidates.length}`,
    `Files emitted: ${entries.length}`,
    `Token budget (estimated): ${tokenBudget}`,
    "",
  ];
  const lines: string[] = [...headerLines];
  let usedBytes = byteLength(lines.join("\n"));
  let emittedFiles = 0;
  for (const entry of entries) {
    const section = renderEntry(entry);
    const nextBytes = usedBytes + byteLength("\n" + section);
    if (nextBytes > budgetBytes) break;
    lines.push(section);
    usedBytes = nextBytes;
    emittedFiles += 1;
  }
  const text = lines.join("\n");
  return {
    text,
    fileCount: emittedFiles,
    emittedBytes: byteLength(text),
    consideredFiles: candidates.length,
  };
}

async function listCandidateFiles(
  platform: Platform,
  cwd: string,
  tokenignore: RegExp[],
): Promise<CandidateFile[]> {
  const git = await safeExec(platform, "git", ["ls-files"], { cwd });
  const rawFiles = git && git.code === 0 && git.stdout.trim().length > 0
    ? git.stdout.split(/\r?\n/).filter(Boolean)
    : walkFiles(cwd).map((file) => normalizePath(path.relative(cwd, file)));

  const files: CandidateFile[] = [];
  for (const raw of rawFiles) {
    const relPath = normalizePath(raw);
    if (!relPath || relPath.startsWith("..")) continue;
    if (isIgnored(relPath, tokenignore)) continue;
    const ext = path.extname(relPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const absPath = path.join(cwd, relPath);
    let size: number;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size === 0 || size > MAX_FILE_BYTES) continue;
    files.push({ relPath, absPath, size });
  }
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

async function safeExec(
  platform: Platform,
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ stdout: string; stderr: string; code: number } | null> {
  try {
    if (typeof platform.exec !== "function") return null;
    return await platform.exec(cmd, args, opts);
  } catch {
    return null;
  }
}

function summarizeFile(file: CandidateFile, fileSet: Set<string>): RepoMapEntry | null {
  if (!SOURCE_EXTENSIONS.has(path.extname(file.relPath).toLowerCase())) {
    return null;
  }
  let text: string;
  try {
    text = fs.readFileSync(file.absPath, "utf8");
  } catch {
    return null;
  }
  const symbols = extractSymbols(text).slice(0, 25);
  const rawImports = extractImports(text);
  const imports = rawImports.slice(0, 25);
  if (symbols.length === 0 && imports.length === 0) return null;
  const resolvedImports = rawImports
    .map((spec) => resolveImport(spec, file.relPath, fileSet))
    .filter((value): value is string => Boolean(value));

  const baseScore = symbols.length * 3 + imports.length;
  return {
    file: file.relPath,
    symbols,
    imports,
    resolvedImports,
    baseScore,
    rank: 0,
    finalScore: baseScore,
  };
}

function applyPageRank(entries: RepoMapEntry[], focus: Set<string>): void {
  if (entries.length === 0) return;
  const indexByFile = new Map(entries.map((entry, index) => [entry.file, index] as const));
  const outEdges: number[][] = entries.map((entry) =>
    entry.resolvedImports
      .map((target) => indexByFile.get(target))
      .filter((value): value is number => value !== undefined),
  );

  const focusIndices = new Set<number>();
  for (const file of focus) {
    const idx = indexByFile.get(file);
    if (idx !== undefined) focusIndices.add(idx);
  }

  const initial = focusIndices.size === 0
    ? entries.map(() => 1 / entries.length)
    : entries.map((_, index) => (focusIndices.has(index) ? 1 / focusIndices.size : 0));

  let rank = initial.slice();
  for (let iteration = 0; iteration < PAGERANK_ITERATIONS; iteration += 1) {
    const next = entries.map(() => 0);
    for (let i = 0; i < entries.length; i += 1) {
      const targets = outEdges[i];
      if (targets.length === 0) {
        // Distribute dangling rank uniformly to focus set or all nodes.
        const recipients = focusIndices.size === 0
          ? entries.map((_, idx) => idx)
          : [...focusIndices];
        for (const idx of recipients) {
          next[idx] += rank[i] / recipients.length;
        }
        continue;
      }
      const share = rank[i] / targets.length;
      for (const target of targets) {
        next[target] += share;
      }
    }
    rank = next.map((value, index) => {
      const personalization = focusIndices.size === 0
        ? 1 / entries.length
        : focusIndices.has(index) ? 1 / focusIndices.size : 0;
      return PAGERANK_DAMPING * value + (1 - PAGERANK_DAMPING) * personalization;
    });
  }

  for (let i = 0; i < entries.length; i += 1) {
    entries[i].rank = rank[i];
    entries[i].finalScore = entries[i].baseScore * (1 + rank[i] * entries.length);
    if (focusIndices.has(i)) {
      entries[i].finalScore += 1000;
    }
  }
}

function renderEntry(entry: RepoMapEntry): string {
  const lines = [`## ${entry.file}`];
  if (entry.symbols.length > 0) lines.push(`symbols: ${entry.symbols.join(", ")}`);
  if (entry.imports.length > 0) lines.push(`imports: ${entry.imports.join(", ")}`);
  if (entry.resolvedImports.length > 0) {
    lines.push(`resolved: ${entry.resolvedImports.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bdef\s+([A-Za-z_][\w]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) symbols.add(match[1]);
  }
  return [...symbols].sort();
}

function extractImports(text: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(["']([^"']+)["']\)/g,
    /\bfrom\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports].sort();
}

function resolveImport(spec: string, importer: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const importerDir = path.posix.dirname(importer);
  const base = spec.startsWith("/") ? spec.slice(1) : path.posix.join(importerDir, spec);
  const normalized = normalizePath(base);
  const candidates: string[] = [];
  if (fileSet.has(normalized)) candidates.push(normalized);
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rb"]) {
    if (normalized.endsWith(ext)) continue;
    const withExt = normalizePath(`${normalized}${ext}`);
    if (fileSet.has(withExt)) candidates.push(withExt);
  }
  for (const indexExt of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    const indexPath = normalizePath(path.posix.join(normalized, `index${indexExt}`));
    if (fileSet.has(indexPath)) candidates.push(indexPath);
  }
  return candidates[0] ?? null;
}

function loadTokenignore(cwd: string): RegExp[] {
  const file = path.join(cwd, ".omp", "supipowers", ".tokenignore");
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(globToRegExp);
  } catch {
    return [];
  }
}

function isIgnored(file: string, tokenignore: RegExp[]): boolean {
  if (file.includes("node_modules/") || file.startsWith(".git/")) return true;
  return tokenignore.some((pattern) => pattern.test(file));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$|/${escaped}$|^${escaped}/`);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}
