import * as fs from "node:fs";
import * as path from "node:path";
import { updateConfig, loadConfig } from "../config/loader.js";

export interface DetectedFramework {
  name: string;
  command: string;
}

const FRAMEWORK_SIGNATURES: { name: string; files: string[]; command: string }[] = [
  { name: "vitest", files: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"], command: "npx vitest run" },
  { name: "jest", files: ["jest.config.ts", "jest.config.js", "jest.config.mjs"], command: "npx jest" },
  { name: "mocha", files: [".mocharc.yml", ".mocharc.json", ".mocharc.js"], command: "npx mocha" },
  { name: "pytest", files: ["pytest.ini", "pyproject.toml", "conftest.py"], command: "pytest" },
  { name: "cargo-test", files: ["Cargo.toml"], command: "cargo test" },
  { name: "go-test", files: ["go.mod"], command: "go test ./..." },
];

export function detectFramework(cwd: string): DetectedFramework | null {
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        const testScript = pkg.scripts.test;
        for (const sig of FRAMEWORK_SIGNATURES) {
          if (testScript.includes(sig.name)) {
            return { name: sig.name, command: "npm test" };
          }
        }
        return { name: "npm-test", command: "npm test" };
      }
    } catch {
      // continue to file-based detection
    }
  }

  for (const sig of FRAMEWORK_SIGNATURES) {
    for (const file of sig.files) {
      if (fs.existsSync(path.join(cwd, file))) {
        return { name: sig.name, command: sig.command };
      }
    }
  }

  return null;
}

export function detectAndCache(cwd: string): DetectedFramework | null {
  const config = loadConfig(cwd);

  if (config.qa.framework && config.qa.command) {
    return { name: config.qa.framework, command: config.qa.command };
  }

  const detected = detectFramework(cwd);
  if (detected) {
    updateConfig(cwd, { qa: { framework: detected.name, command: detected.command } });
  }
  return detected;
}
