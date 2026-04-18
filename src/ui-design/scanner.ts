import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextScan } from "./types.js";
import { scanDesignTokens } from "./tokens-scanner.js";
import { scanExistingComponents, type ScanExistingComponentsOptions } from "./components-scanner.js";

export interface ScanDesignContextOptions {
  components?: ScanExistingComponentsOptions;
}

const DESIGN_MD_CANDIDATES: Array<{ dir: string; filenames: string[] }> = [
  { dir: "", filenames: ["design.md", "DESIGN.md"] },
  { dir: "docs", filenames: ["design.md", "DESIGN.md"] },
];

const FRAMEWORK_DEPS: Array<{ dep: string; framework: "react" | "vue" | "svelte" | "next" | "nuxt" }> = [
  { dep: "next", framework: "next" },
  { dep: "nuxt", framework: "nuxt" },
  { dep: "react", framework: "react" },
  { dep: "vue", framework: "vue" },
  { dep: "svelte", framework: "svelte" },
];

const UI_LIBRARY_ALLOWLIST = [
  "tailwindcss",
  "@mui/material",
  "@chakra-ui/react",
  "@mantine/core",
  "shadcn-ui",
];

const UI_LIBRARY_PREFIXES: Array<{ prefix: string; collapseTo: string }> = [
  { prefix: "@radix-ui/", collapseTo: "@radix-ui" },
];

function resolveExistingPathWithActualCase(dir: string, filename: string): string | null {
  const requestedPath = path.join(dir, filename);
  if (!fs.existsSync(requestedPath)) return null;

  const actualFilename = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === filename.toLowerCase());
  if (!actualFilename) return null;

  return path.join(dir, actualFilename);
}

function scanDesignMd(repoRoot: string): ContextScan["designMd"] {
  try {
    for (const { dir, filenames } of DESIGN_MD_CANDIDATES) {
      const parentDir = path.join(repoRoot, dir);
      for (const filename of filenames) {
        const abs = resolveExistingPathWithActualCase(parentDir, filename);
        if (!abs) continue;

        const stat = fs.statSync(abs);
        if (!stat.isFile()) continue;

        return { status: "ok", path: abs, bytes: stat.size };
      }
    }
    return { status: "missing" };
  } catch (err) {
    return { status: "error", reason: (err as Error).message };
  }
}

function scanPackageInfo(repoRoot: string): ContextScan["packageInfo"] {
  try {
    const pkgPath = path.join(repoRoot, "package.json");
    if (!fs.existsSync(pkgPath)) return { status: "missing" };

    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    };

    let framework: "react" | "vue" | "svelte" | "next" | "nuxt" | "unknown" = "unknown";
    for (const { dep, framework: f } of FRAMEWORK_DEPS) {
      if (allDeps[dep]) {
        framework = f;
        break;
      }
    }

    const uiLibraries = new Set<string>();
    for (const name of UI_LIBRARY_ALLOWLIST) {
      if (allDeps[name]) uiLibraries.add(name);
    }
    for (const { prefix, collapseTo } of UI_LIBRARY_PREFIXES) {
      if (Object.keys(allDeps).some((k) => k.startsWith(prefix))) {
        uiLibraries.add(collapseTo);
      }
    }

    return { status: "ok", framework, uiLibraries: Array.from(uiLibraries) };
  } catch (err) {
    return { status: "error", reason: (err as Error).message };
  }
}

/**
 * Scan the repo for UI design context. Never throws; each field degrades
 * independently. The director uses the resulting `ContextScan` as the canonical
 * design brief input.
 */
export async function scanDesignContext(
  repoRoot: string,
  opts: ScanDesignContextOptions = {},
): Promise<ContextScan> {
  let tokens: ContextScan["tokens"];
  try {
    tokens = await scanDesignTokens(repoRoot);
  } catch (err) {
    tokens = { status: "error", reason: (err as Error).message };
  }

  let components: ContextScan["components"];
  try {
    components = await scanExistingComponents(repoRoot, opts.components);
  } catch (err) {
    components = { status: "error", items: [], reason: (err as Error).message };
  }

  const designMd = scanDesignMd(repoRoot);
  const packageInfo = scanPackageInfo(repoRoot);

  return {
    scannedAt: new Date().toISOString(),
    tokens,
    components,
    designMd,
    packageInfo,
  };
}
