import * as path from "node:path";
import { describe, expect, test } from "bun:test";

interface NpmPackDryRunEntry {
  files: Array<{ path: string }>;
}

async function npmPackDryRunFileSet(): Promise<Set<string>> {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const entries = JSON.parse(stdout) as NpmPackDryRunEntry[];
  return new Set(entries.flatMap((entry) => entry.files.map((file) => file.path)));
}

describe("published package contents", () => {
  test("ships a visual companion lockfile accepted by postinstall npm ci", async () => {
    const files = await npmPackDryRunFileSet();
    const hasPackageLock = files.has("src/visual/scripts/package-lock.json");
    const hasShrinkwrap = files.has("src/visual/scripts/npm-shrinkwrap.json");

    expect(files.has("package.json")).toBe(true);
    expect(files.has("src/visual/scripts/package.json")).toBe(true);
    expect(hasPackageLock || hasShrinkwrap).toBe(true);
  });
});
