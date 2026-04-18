import { describe, expect, test } from "bun:test";
import {
  getRunner,
  getSupportedLanguages,
} from "../../../src/context-mode/sandbox/runners.js";

const ALL_LANGUAGES = [
  "elixir",
  "go",
  "javascript",
  "perl",
  "php",
  "python",
  "r",
  "ruby",
  "rust",
  "shell",
  "typescript",
];

describe("getRunner", () => {
  const expected: Record<string, { binary: string[]; fileExt: string }> = {
    javascript: { binary: ["bun", "run"], fileExt: ".js" },
    typescript: { binary: ["bun", "run"], fileExt: ".ts" },
    python: {
      binary: process.platform === "win32" ? ["python"] : ["python3"],
      fileExt: ".py",
    },
    shell: { binary: ["bash"], fileExt: ".sh" },
    ruby: { binary: ["ruby"], fileExt: ".rb" },
    go: { binary: ["go", "run"], fileExt: ".go" },
    rust: { binary: ["rustc"], fileExt: ".rs" },
    php: { binary: ["php"], fileExt: ".php" },
    perl: { binary: ["perl"], fileExt: ".pl" },
    r: { binary: ["Rscript"], fileExt: ".R" },
    elixir: { binary: ["elixir"], fileExt: ".exs" },
  };

  for (const [lang, config] of Object.entries(expected)) {
    test(`returns correct config for ${lang}`, () => {
      const runner = getRunner(lang);
      expect(runner.binary).toEqual(config.binary);
      expect(runner.fileExt).toBe(config.fileExt);
    });
  }

  test("rust has needsCompile and compileCmd", () => {
    const runner = getRunner("rust");
    expect(runner.needsCompile).toBe(true);
    expect(runner.compileCmd).toBeFunction();
    expect(runner.compileCmd!("/tmp/main.rs", "/tmp/main")).toEqual([
      "rustc",
      "/tmp/main.rs",
      "-o",
      "/tmp/main",
    ]);
  });

  test("throws for unsupported language with descriptive message", () => {
    expect(() => getRunner("invalid")).toThrow(
      /Unsupported language: "invalid"/,
    );
    expect(() => getRunner("invalid")).toThrow(/Supported:/);
    try {
      getRunner("invalid");
    } catch (e: any) {
      for (const lang of ALL_LANGUAGES) {
        expect(e.message).toContain(lang);
      }
    }
  });

  test("is case-sensitive — Python throws", () => {
    expect(() => getRunner("Python")).toThrow(/Unsupported language: "Python"/);
  });
});

describe("getSupportedLanguages", () => {
  test("returns all 11 languages in sorted order", () => {
    const languages = getSupportedLanguages();
    expect(languages).toEqual(ALL_LANGUAGES);
    expect(languages).toHaveLength(11);
  });
});

describe("runner invariants", () => {
  test("all runners have non-empty binary arrays and fileExt starting with .", () => {
    for (const lang of getSupportedLanguages()) {
      const runner = getRunner(lang);
      expect(runner.binary.length).toBeGreaterThan(0);
      expect(runner.fileExt).toStartWith(".");
      expect(runner.fileExt.length).toBeGreaterThan(1);
    }
  });
});