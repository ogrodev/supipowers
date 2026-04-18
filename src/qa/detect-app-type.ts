import * as fs from "node:fs";
import * as path from "node:path";
import type { AppType } from "./types.js";

export interface AppDetection {
  type: AppType;
  devCommand: string;
  port: number;
  baseUrl: string;
  isLikelyApp: boolean;
}

function fileExists(cwd: string, ...segments: string[]): boolean {
  return fs.existsSync(path.join(cwd, ...segments));
}

function dirExists(cwd: string, ...segments: string[]): boolean {
  try {
    return fs.statSync(path.join(cwd, ...segments)).isDirectory();
  } catch {
    return false;
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function detectAppType(cwd: string): AppDetection {
  let type: AppType = "generic";
  let devCommand = "npm run dev";
  let port = 3000;
  let isLikelyApp = false;

  const hasNextConfig =
    fileExists(cwd, "next.config.js") ||
    fileExists(cwd, "next.config.mjs") ||
    fileExists(cwd, "next.config.ts");
  const hasNextAppDir = dirExists(cwd, "app") || dirExists(cwd, "src", "app");
  const hasNextPagesDir = dirExists(cwd, "pages") || dirExists(cwd, "src", "pages");

  if (hasNextConfig || hasNextAppDir || hasNextPagesDir) {
    if (hasNextAppDir) {
      type = "nextjs-app";
    } else if (hasNextPagesDir) {
      type = "nextjs-pages";
    } else {
      type = "nextjs-app";
    }
    port = 3000;
    isLikelyApp = true;
  } else if (
    fileExists(cwd, "vite.config.ts") ||
    fileExists(cwd, "vite.config.js") ||
    fileExists(cwd, "vite.config.mjs")
  ) {
    type = "vite";
    port = 5173;
    isLikelyApp = true;
  } else if (fileExists(cwd, "angular.json")) {
    type = "generic";
    devCommand = "npm start";
    port = 4200;
    isLikelyApp = true;
  } else if (fileExists(cwd, "package.json")) {
    try {
      const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
      if (raw.includes('"express"')) {
        type = "express";
        port = 3000;
        isLikelyApp = true;
      }
    } catch {
      // proceed with defaults
    }
  }

  const pkgPath = path.join(cwd, "package.json");
  const pkg = readJson(pkgPath);
  if (pkg) {
    const scripts = pkg.scripts as Record<string, string> | undefined;
    if (scripts?.dev) {
      devCommand = "npm run dev";
      isLikelyApp = true;
    } else if (scripts?.start) {
      devCommand = "npm start";
      isLikelyApp = true;
    } else if (scripts?.serve) {
      devCommand = "npm run serve";
      isLikelyApp = true;
    }

    const scriptText = scripts?.dev ?? scripts?.start ?? "";
    if (scriptText) {
      const portMatch = scriptText.match(/(?:--port|PORT=)\s*(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
    }
  }

  const baseUrl = `http://localhost:${port}`;

  return { type, devCommand, port, baseUrl, isLikelyApp };
}
