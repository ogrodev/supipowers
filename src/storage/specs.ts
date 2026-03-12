import * as fs from "node:fs";
import * as path from "node:path";

const SPECS_DIR = ["docs", "supipowers", "specs"];

/** Get the specs directory path */
export function getSpecsDir(cwd: string): string {
  return path.join(cwd, ...SPECS_DIR);
}

/** Save a spec markdown file */
export function saveSpec(cwd: string, filename: string, content: string): string {
  const dir = getSpecsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Read a spec file by name */
export function readSpec(cwd: string, name: string): string | null {
  const filePath = path.join(getSpecsDir(cwd), name);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/** List all spec files, newest first */
export function listSpecs(cwd: string): string[] {
  const dir = getSpecsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
}
