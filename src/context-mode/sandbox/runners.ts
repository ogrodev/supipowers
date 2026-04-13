export interface LanguageRunner {
  binary: string[];
  fileExt: string;
  needsCompile?: boolean;
  compileCmd?: (srcPath: string, outPath: string) => string[];
}

const RUNNERS: Record<string, LanguageRunner> = {
  javascript: { binary: ["bun", "run"], fileExt: ".js" },
  typescript: { binary: ["bun", "run"], fileExt: ".ts" },
  python: { binary: ["python3"], fileExt: ".py" },
  shell: { binary: ["bash"], fileExt: ".sh" },
  ruby: { binary: ["ruby"], fileExt: ".rb" },
  go: { binary: ["go", "run"], fileExt: ".go" },
  rust: {
    binary: ["rustc"],
    fileExt: ".rs",
    needsCompile: true,
    compileCmd: (src, out) => ["rustc", src, "-o", out],
  },
  php: { binary: ["php"], fileExt: ".php" },
  perl: { binary: ["perl"], fileExt: ".pl" },
  r: { binary: ["Rscript"], fileExt: ".R" },
  elixir: { binary: ["elixir"], fileExt: ".exs" },
};

export function getRunner(language: string): LanguageRunner {
  const runner = RUNNERS[language];
  if (!runner) {
    const supported = getSupportedLanguages().join(", ");
    throw new Error(
      `Unsupported language: "${language}". Supported: ${supported}`,
    );
  }
  return runner;
}

export function getSupportedLanguages(): string[] {
  return Object.keys(RUNNERS).sort();
}
