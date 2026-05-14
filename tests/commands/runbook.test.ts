import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  discoverRegisteredRules,
  formatCommandsRunbook,
  formatRulesRunbook,
  formatTtsrRunbook,
  parseRunbookMode,
  registerRunbookCommand,
} from "../../src/commands/runbook.js";
import type { CommandInfo, Platform } from "../../src/platform/types.js";

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createPlatform(commands: CommandInfo[] = [{ name: "runbook", description: "Show runbook" }]): Platform {
  return {
    name: "omp",
    registerCommand: mock(),
    getCommands: mock(() => commands),
    on: mock(),
    exec: mock(async () => ({ code: 0, stdout: "", stderr: "" })),
    sendMessage: mock(),
    sendUserMessage: mock(),
    getActiveTools: mock(() => []),
    registerMessageRenderer: mock(),
    createAgentSession: mock(),
    paths: {
      dotDir: ".omp",
      dotDirDisplay: ".omp",
      project: (cwd: string, ...segments: string[]) => path.join(cwd, ".omp", "supipowers", ...segments),
      global: (...segments: string[]) => path.join(os.tmpdir(), "global", ...segments),
      agent: (...segments: string[]) => path.join(os.tmpdir(), "agent", ...segments),
    },
    capabilities: {
      agentSessions: true,
      compactionHooks: false,
      customWidgets: false,
      registerTool: false,
      activeToolFiltering: false,
    },
  } as unknown as Platform;
}

describe("runbook rule discovery", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "supi-runbook-test-"));
    homeDir = path.join(tmpDir, "home");

    writeFile(
      path.join(tmpDir, ".omp", "rules", "acp.md"),
      [
        "---",
        "description: Agent Client Protocol reference",
        "---",
        "# ACP",
      ].join("\n"),
    );
    writeFile(
      path.join(tmpDir, ".omp", "rules", "verification.md"),
      [
        "---",
        "condition:",
        "  - '\\b[Dd]one\\b'",
        "triggers:",
        "  - done",
        "scope:",
        "  - text",
        "interruptMode: prose-only",
        "---",
        "# Verification",
      ].join("\n"),
    );
    writeFile(
      path.join(tmpDir, ".omp", "rules", "always.md"),
      [
        "---",
        "alwaysApply: true",
        "---",
        "# Always",
      ].join("\n"),
    );
    writeFile(path.join(tmpDir, ".omp", "rules", "inactive.md"), "# Inactive\n");
    writeFile(
      path.join(homeDir, ".omp", "agent", "rules", "acp.md"),
      [
        "---",
        "description: Shadowed user ACP rule",
        "---",
        "# User ACP",
      ].join("\n"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads project rules, classifies buckets, and reports shadowed duplicates", () => {
    const discovery = discoverRegisteredRules(tmpDir, { homeDir });

    expect(discovery.active.map((rule) => [rule.name, rule.bucket]).sort()).toEqual([
      ["acp", "rulebook"],
      ["always", "always"],
      ["inactive", "inactive"],
      ["verification", "ttsr"],
    ]);
    expect(discovery.shadowed).toHaveLength(1);
    expect(discovery.shadowed[0].name).toBe("acp");
  });

  test("formats all rule categories with application details", () => {
    const discovery = discoverRegisteredRules(tmpDir, { homeDir });
    const report = formatRulesRunbook(discovery, tmpDir);

    expect(report).toContain("/runbook rules");
    expect(report).toContain("4 registered (1 TTSR, 1 rulebook, 1 always-apply, 1 inactive)");
    expect(report).toContain("Applies: when assistant output matches the trigger phrase(s)");
    expect(report).toContain("Triggers: done");
    expect(report).toContain("Scope: assistant prose only");
    expect(report).toContain("Applies: on demand via rule://acp");
    expect(report).toContain("Applies: alwaysApply=true");
    expect(report).toContain("Shadowed rules (1)");
  });

  test("formats TTSR-only runbook", () => {
    const discovery = discoverRegisteredRules(tmpDir, { homeDir });
    const report = formatTtsrRunbook(discovery, tmpDir);

    expect(report).toContain("/runbook rules ttsr");
    expect(report).toContain("TTSR rules: 1");
    expect(report).toContain("verification");
    expect(report).not.toContain("rule://acp");
  });
});

describe("runbook command", () => {
  test("parses supported command aliases", () => {
    expect(parseRunbookMode(undefined)).toBe("rules");
    expect(parseRunbookMode("rules")).toBe("rules");
    expect(parseRunbookMode("rules ttsr")).toBe("ttsr");
    expect(parseRunbookMode("ttsr")).toBe("ttsr");
    expect(parseRunbookMode("rules commands")).toBe("commands");
    expect(parseRunbookMode("commands")).toBe("commands");
    expect(parseRunbookMode("unknown")).toBe("help");
  });

  test("formats registered slash commands without invoking the model", async () => {
    const platform = createPlatform([
      { name: "supi:status", description: "Show status", source: "supipowers" },
      { name: "runbook", description: "Show runbook" },
    ]);
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        notify: mock(),
        select: mock(),
        input: mock(),
      },
    };

    registerRunbookCommand(platform);
    const command = (platform.registerCommand as ReturnType<typeof mock>).mock.calls[0][1];
    await command.handler("commands", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("Registered slash commands: 2");
    expect(ctx.ui.notify.mock.calls[0][0]).toContain("/supi:status (supipowers)");
    expect(platform.sendMessage).not.toHaveBeenCalled();
    expect(platform.sendUserMessage).not.toHaveBeenCalled();
  });

  test("formats command runbook sorted by command name", () => {
    const report = formatCommandsRunbook([
      { name: "zeta", description: "Last" },
      { name: "alpha", description: "First" },
    ]);

    expect(report.indexOf("/alpha")).toBeLessThan(report.indexOf("/zeta"));
  });
});
