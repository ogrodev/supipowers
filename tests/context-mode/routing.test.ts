// tests/context-mode/routing.test.ts
import { isHttpCommand, isBashSearchCommand, isFullFileRead, routeToolCall } from "../../src/context-mode/routing.js";
import type { ContextModeStatus } from "../../src/context-mode/detector.js";

describe("isBashSearchCommand", () => {
  test("blocks find commands", () => {
    expect(isBashSearchCommand("find . -name '*.ts'")).toBe(true);
    expect(isBashSearchCommand("find /src -type f")).toBe(true);
  });

  test("blocks grep commands", () => {
    expect(isBashSearchCommand("grep -r 'pattern' .")).toBe(true);
    expect(isBashSearchCommand("grep -rn 'foo' src/")).toBe(true);
  });

  test("blocks rg commands", () => {
    expect(isBashSearchCommand("rg 'pattern'")).toBe(true);
    expect(isBashSearchCommand("rg --type ts 'foo'")).toBe(true);
  });

  test("blocks ag commands", () => {
    expect(isBashSearchCommand("ag 'pattern' src/")).toBe(true);
  });

  test("blocks fd commands", () => {
    expect(isBashSearchCommand("fd '*.ts'")).toBe(true);
  });

  test("blocks ack commands", () => {
    expect(isBashSearchCommand("ack 'pattern'")).toBe(true);
  });

  test("allows git commands (even with piped grep)", () => {
    expect(isBashSearchCommand("git log --oneline")).toBe(false);
    expect(isBashSearchCommand("git log | grep fix")).toBe(false);
    expect(isBashSearchCommand("git status")).toBe(false);
    expect(isBashSearchCommand("git diff HEAD")).toBe(false);
  });

  test("allows package manager commands", () => {
    expect(isBashSearchCommand("npm install")).toBe(false);
    expect(isBashSearchCommand("npm run build")).toBe(false);
    expect(isBashSearchCommand("yarn add react")).toBe(false);
    expect(isBashSearchCommand("pnpm install")).toBe(false);
    expect(isBashSearchCommand("npx vitest run")).toBe(false);
  });

  test("allows filesystem operations", () => {
    expect(isBashSearchCommand("ls -la")).toBe(false);
    expect(isBashSearchCommand("mkdir -p foo/bar")).toBe(false);
    expect(isBashSearchCommand("rm -rf dist")).toBe(false);
    expect(isBashSearchCommand("mv old.ts new.ts")).toBe(false);
    expect(isBashSearchCommand("cp src/a.ts src/b.ts")).toBe(false);
    expect(isBashSearchCommand("touch newfile.ts")).toBe(false);
  });

  test("allows runtime commands", () => {
    expect(isBashSearchCommand("node script.js")).toBe(false);
    expect(isBashSearchCommand("python3 analyze.py")).toBe(false);
    expect(isBashSearchCommand("tsc --noEmit")).toBe(false);
  });

  test("allows test runners", () => {
    expect(isBashSearchCommand("vitest run")).toBe(false);
    expect(isBashSearchCommand("jest --coverage")).toBe(false);
  });

  test("allows other safe commands", () => {
    expect(isBashSearchCommand("echo hello")).toBe(false);
    expect(isBashSearchCommand("cat file.txt")).toBe(false);
    expect(isBashSearchCommand("docker ps")).toBe(false);
    expect(isBashSearchCommand("brew install node")).toBe(false);
    expect(isBashSearchCommand("chmod +x script.sh")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isBashSearchCommand(undefined)).toBe(false);
    expect(isBashSearchCommand(null)).toBe(false);
    expect(isBashSearchCommand(42)).toBe(false);
  });
});

describe("isFullFileRead", () => {
  test("returns true when no limit or offset", () => {
    expect(isFullFileRead({})).toBe(true);
    expect(isFullFileRead({ file_path: "/foo/bar.ts" })).toBe(true);
  });

  test("returns true when input is undefined", () => {
    expect(isFullFileRead(undefined)).toBe(true);
  });

  test("returns false when limit is set", () => {
    expect(isFullFileRead({ limit: 50 })).toBe(false);
    expect(isFullFileRead({ limit: 200, file_path: "/foo.ts" })).toBe(false);
  });

  test("returns false when offset is set", () => {
    expect(isFullFileRead({ offset: 10 })).toBe(false);
    expect(isFullFileRead({ offset: 0 })).toBe(false);
  });

  test("returns false when both limit and offset are set", () => {
    expect(isFullFileRead({ limit: 50, offset: 10 })).toBe(false);
  });

  test("returns false when sel is set", () => {
    expect(isFullFileRead({ sel: "L50-L120" })).toBe(false);
    expect(isFullFileRead({ sel: "raw" })).toBe(false);
  });

  test("returns false when sel and limit are both set", () => {
    expect(isFullFileRead({ sel: "L50", limit: 50 })).toBe(false);
  });
});

describe("isHttpCommand", () => {
  test("detects curl commands", () => {
    expect(isHttpCommand("curl https://example.com")).toBe(true);
    expect(isHttpCommand("curl -s https://example.com")).toBe(true);
  });

  test("detects wget commands", () => {
    expect(isHttpCommand("wget https://example.com")).toBe(true);
    expect(isHttpCommand("wget -q https://example.com/file")).toBe(true);
  });

  test("does not match non-HTTP commands", () => {
    expect(isHttpCommand("echo hello")).toBe(false);
    expect(isHttpCommand("git status")).toBe(false);
    expect(isHttpCommand("npm install")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isHttpCommand(undefined)).toBe(false);
    expect(isHttpCommand(null)).toBe(false);
  });
});

  test("detects JavaScript fetch() calls", () => {
    expect(isHttpCommand('node -e "fetch(\"https://api.example.com\")"')).toBe(true);
    expect(isHttpCommand("fetch('http://localhost:3000')")).toBe(true);
  });

  test("detects Python requests calls", () => {
    expect(isHttpCommand('python -c "import requests; requests.get(\"https://api.example.com\")"')).toBe(true);
    expect(isHttpCommand("requests.post('http://localhost')")).toBe(true);
  });

  test("detects Node http module calls", () => {
    expect(isHttpCommand('node -e "http.get(\"http://localhost\")"')).toBe(true);
    expect(isHttpCommand("http.request('http://api.example.com')")).toBe(true);
  });

  test("detects Python urllib", () => {
    expect(isHttpCommand("python -c 'urllib.request.urlopen(...)'")).toBe(true);
  });

  test("detects PowerShell Invoke-WebRequest", () => {
    expect(isHttpCommand("Invoke-WebRequest -Uri https://example.com")).toBe(true);
  });

  test("does not false-positive on git fetch", () => {
    expect(isHttpCommand("git fetch origin")).toBe(false);
    expect(isHttpCommand("git fetch --all")).toBe(false);
  });

  test("does not false-positive on non-HTTP fetch usage", () => {
    expect(isHttpCommand("fetchmail")).toBe(false);
  });

// Helper: all ctx tools available
const ALL_TOOLS: ContextModeStatus = {
  available: true,
  tools: {
    ctxExecute: true, ctxBatchExecute: true, ctxExecuteFile: true,
    ctxIndex: true, ctxSearch: true, ctxFetchAndIndex: true,
  },
};

const NO_TOOLS: ContextModeStatus = {
  available: false,
  tools: {
    ctxExecute: false, ctxBatchExecute: false, ctxExecuteFile: false,
    ctxIndex: false, ctxSearch: false, ctxFetchAndIndex: false,
  },
};

const ENFORCE = { enforceRouting: true, blockHttpCommands: true };
const NO_ENFORCE = { enforceRouting: false, blockHttpCommands: true };

describe("routeToolCall", () => {
  test("blocks Grep when ctxSearch available", () => {
    const result = routeToolCall("grep", { pattern: "foo" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("ctx_search");
  });

  test("allows Grep when ctxSearch not available", () => {
    const result = routeToolCall("grep", { pattern: "foo" }, NO_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
  });

  test("allows Grep when enforceRouting disabled", () => {
    const result = routeToolCall("grep", { pattern: "foo" }, ALL_TOOLS, NO_ENFORCE);
    expect(result).toBeUndefined();
  });

  test("allows Read through (never blocked)", () => {
    const result = routeToolCall("read", { file_path: "/foo.ts" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
  });

  test("allows Read with scoped params", () => {
    const result = routeToolCall("read", { file_path: "/foo.ts", offset: 10 }, ALL_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
    const result2 = routeToolCall("read", { file_path: "/foo.ts", sel: "L50-L120" }, ALL_TOOLS, ENFORCE);
    expect(result2).toBeUndefined();
  });

  test("blocks Bash search commands", () => {
    const result = routeToolCall("bash", { command: "find . -name '*.ts'" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("ctx_execute");
  });

  test("allows Bash git commands", () => {
    const result = routeToolCall("bash", { command: "git log --oneline" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
  });

  test("blocks Bash HTTP commands", () => {
    const result = routeToolCall("bash", { command: "curl https://example.com" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("ctx_fetch_and_index");
  });

  test("allows Bash search when enforceRouting disabled", () => {
    const result = routeToolCall("bash", { command: "find . -name '*.ts'" }, ALL_TOOLS, NO_ENFORCE);
    expect(result).toBeUndefined();
  });

  test("blocks Find/Glob when ctxExecute available", () => {
    const result = routeToolCall("find", { pattern: "**/*.ts" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("ctx_execute");
  });

  test("allows Find/Glob when ctxExecute not available", () => {
    const result = routeToolCall("find", { pattern: "**/*.ts" }, NO_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
  });

  test("allows Find/Glob when enforceRouting disabled", () => {
    const result = routeToolCall("find", { pattern: "**/*.ts" }, ALL_TOOLS, NO_ENFORCE);
    expect(result).toBeUndefined();
  });

  test("blocks Fetch/WebFetch when ctxFetchAndIndex available", () => {
    const result = routeToolCall("fetch", { url: "https://example.com" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("ctx_fetch_and_index");
  });

  test("blocks web_fetch variant", () => {
    const result = routeToolCall("web_fetch", { url: "https://example.com" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  test("allows Fetch when ctxFetchAndIndex not available", () => {
    const result = routeToolCall("fetch", { url: "https://example.com" }, NO_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
  });

  test("allows unknown tools through", () => {
    const result = routeToolCall("edit", { file_path: "/foo.ts" }, ALL_TOOLS, ENFORCE);
    expect(result).toBeUndefined();
  });
});
