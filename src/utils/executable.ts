import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ""];
const POSIX_EXECUTABLE_EXTENSIONS = [""];

export interface ExecutableSearchOptions {
  cwd?: string;
  localDirs?: string[];
  preferLocal?: boolean;
  searchPath?: string;
  pathext?: string;
}

function windowsExecutableExtensions(pathext?: string): string[] {
  const ordered = (pathext ?? process.env.PATHEXT ?? "")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));

  return [...new Set([...ordered, ...DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS])];
}

function executableExtensions(options: ExecutableSearchOptions): string[] {
  return process.platform === "win32"
    ? windowsExecutableExtensions(options.pathext)
    : POSIX_EXECUTABLE_EXTENSIONS;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveSearchDirectories(options: ExecutableSearchOptions): string[] {
  const pathDirs = (options.searchPath ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const localDirs = (options.localDirs ?? []).map((dir) =>
    options.cwd ? path.join(options.cwd, dir) : dir,
  );

  return options.preferLocal
    ? [...localDirs, ...pathDirs]
    : [...pathDirs, ...localDirs];
}

export function findExecutable(
  executable: string,
  options: ExecutableSearchOptions = {},
): string | null {
  const seen = new Set<string>();
  const extensions = executableExtensions(options);

  for (const directory of resolveSearchDirectories(options)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function hasExecutable(
  executable: string,
  options: ExecutableSearchOptions = {},
): boolean {
  return findExecutable(executable, options) !== null;
}
