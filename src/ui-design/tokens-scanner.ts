import * as fs from "node:fs";
import * as path from "node:path";
import type { DesignTokens } from "./types.js";

const TAILWIND_CONFIG_NAMES = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

const MAX_RAW_BYTES = 4 * 1024;

function truncate(value: string): string {
  return value.length > MAX_RAW_BYTES ? value.slice(0, MAX_RAW_BYTES) : value;
}

function findTailwindConfig(repoRoot: string): string | null {
  for (const name of TAILWIND_CONFIG_NAMES) {
    const p = path.join(repoRoot, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isInside(configPath: string, repoRoot: string): boolean {
  try {
    const realConfig = fs.realpathSync(configPath);
    const realRoot = fs.realpathSync(repoRoot);
    const rel = path.relative(realRoot, realConfig);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function scanTailwindRegex(source: string): {
  colors: Record<string, string>;
  fonts: Record<string, string[]>;
} | null {
  const colors: Record<string, string> = {};
  const colorsMatch = source.match(/colors\s*:\s*\{([^}]*)\}/);
  if (colorsMatch) {
    const entryRe = /([\w-]+)\s*:\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(colorsMatch[1]!)) !== null) {
      colors[m[1]!] = m[2]!;
    }
  }

  const fonts: Record<string, string[]> = {};
  const fontsMatch = source.match(/fontFamily\s*:\s*\{([^}]*)\}/);
  if (fontsMatch) {
    const entryRe = /([\w-]+)\s*:\s*\[([^\]]*)\]/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(fontsMatch[1]!)) !== null) {
      const inner = m[2]!.match(/["']([^"']+)["']/g) ?? [];
      fonts[m[1]!] = inner.map((s) => s.slice(1, -1));
    }
  }

  if (Object.keys(colors).length === 0 && Object.keys(fonts).length === 0) {
    return null;
  }
  return { colors, fonts };
}

function scanCssVariables(repoRoot: string): {
  source: string;
  colors: Record<string, string>;
  fonts: Record<string, string[]>;
  raw: string;
} | null {
  let entries: { file: string; content: string }[];
  try {
    entries = fs
      .readdirSync(repoRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(css|scss)$/.test(e.name))
      .map((e) => ({
        file: path.join(repoRoot, e.name),
        content: fs.readFileSync(path.join(repoRoot, e.name), "utf-8"),
      }));
  } catch {
    return null;
  }

  const colors: Record<string, string> = {};
  const fonts: Record<string, string[]> = {};
  const rawParts: string[] = [];

  for (const { content } of entries) {
    const rootBlocks = content.match(/:root\s*\{[^}]*\}/g);
    if (!rootBlocks) continue;
    for (const block of rootBlocks) {
      rawParts.push(block);
      const varRe = /--([\w-]+)\s*:\s*([^;]+);/g;
      let m: RegExpExecArray | null;
      while ((m = varRe.exec(block)) !== null) {
        const key = m[1]!.trim();
        const value = m[2]!.trim();
        if (/^#|^rgb|^hsl|^oklch/i.test(value) || /^color-/.test(key)) {
          colors[key] = value;
        } else if (/^font-/.test(key)) {
          fonts[key] = [value];
        } else {
          colors[key] = value;
        }
      }
    }
  }

  if (Object.keys(colors).length === 0 && Object.keys(fonts).length === 0) {
    return null;
  }

  return { source: "css-vars", colors, fonts, raw: rawParts.join("\n\n") };
}

/**
 * Inspect the repo for design tokens.
 *
 * Detection order:
 *   1. Tailwind config via static regex extraction.
 *   2. Top-level CSS/SCSS :root { --… } blocks.
 *   3. `missing` when nothing is found.
 *
 * Always returns a DesignTokens; never throws.
 */
export async function scanDesignTokens(repoRoot: string): Promise<DesignTokens> {
  const configPath = findTailwindConfig(repoRoot);
  if (configPath) {
    if (!isInside(configPath, repoRoot)) {
      return { status: "error", reason: "tailwind config resolves outside repo root" };
    }

    let rawSource = "";
    try {
      rawSource = fs.readFileSync(configPath, "utf-8");
    } catch (err) {
      return {
        status: "error",
        reason: `failed to read tailwind config: ${(err as Error).message}`,
      };
    }

    try {
      const reg = scanTailwindRegex(rawSource);
      if (reg) {
        return {
          status: "ok",
          source: "tailwind",
          colors: reg.colors,
          fonts: reg.fonts,
          raw: truncate(rawSource),
        };
      }
    } catch (err) {
      return {
        status: "error",
        reason: `tailwind regex scan failed: ${(err as Error).message}`,
      };
    }
  }

  try {
    const css = scanCssVariables(repoRoot);
    if (css) {
      return {
        status: "ok",
        source: "css-vars",
        colors: css.colors,
        fonts: css.fonts,
        raw: truncate(css.raw),
      };
    }
  } catch (err) {
    return { status: "error", reason: `css scan failed: ${(err as Error).message}` };
  }

  return { status: "missing" };
}
