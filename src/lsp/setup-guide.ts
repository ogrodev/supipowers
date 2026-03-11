// src/lsp/setup-guide.ts

export interface SetupInstruction {
  language: string;
  server: string;
  installCommand: string;
  notes: string;
}

const COMMON_LSP_SERVERS: SetupInstruction[] = [
  {
    language: "TypeScript/JavaScript",
    server: "typescript-language-server",
    installCommand: "bun add -g typescript-language-server typescript",
    notes: "Requires a tsconfig.json in your project root.",
  },
  {
    language: "Python",
    server: "pyright",
    installCommand: "pip install pyright",
    notes: "Works best with a pyrightconfig.json or pyproject.toml.",
  },
  {
    language: "Rust",
    server: "rust-analyzer",
    installCommand: "rustup component add rust-analyzer",
    notes: "Requires a Cargo.toml project.",
  },
  {
    language: "Go",
    server: "gopls",
    installCommand: "go install golang.org/x/tools/gopls@latest",
    notes: "Requires a go.mod project.",
  },
];

/** Get setup instructions for detected project languages */
export function getSetupInstructions(detectedLanguages: string[]): SetupInstruction[] {
  return COMMON_LSP_SERVERS.filter((s) =>
    detectedLanguages.some((lang) =>
      s.language.toLowerCase().includes(lang.toLowerCase())
    )
  );
}

/** Detect project languages from file extensions */
export function detectProjectLanguages(files: string[]): string[] {
  const extMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
  };
  const languages = new Set<string>();
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf("."));
    if (extMap[ext]) languages.add(extMap[ext]);
  }
  return [...languages];
}

/** Format setup instructions as readable text */
export function formatSetupGuide(instructions: SetupInstruction[]): string {
  if (instructions.length === 0) {
    return "No LSP setup instructions available for your project languages.";
  }
  const lines = ["LSP Setup Guide:", ""];
  for (const inst of instructions) {
    lines.push(`## ${inst.language} — ${inst.server}`);
    lines.push(`Install: ${inst.installCommand}`);
    lines.push(`Note: ${inst.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}
