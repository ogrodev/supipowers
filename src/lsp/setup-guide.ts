// src/lsp/setup-guide.ts

export interface LspServerEntry {
  language: string;
  server: string;
  installCommand: string;
  notes: string;
}

export const LSP_SERVERS: LspServerEntry[] = [
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

/** Format all LSP servers as readable text */
export function formatSetupGuide(servers: LspServerEntry[] = LSP_SERVERS): string {
  if (servers.length === 0) {
    return "No LSP servers available.";
  }
  const lines = ["LSP Setup Guide:", ""];
  for (const srv of servers) {
    lines.push(`## ${srv.language} — ${srv.server}`);
    lines.push(`Install: ${srv.installCommand}`);
    lines.push(`Note: ${srv.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}
