import type { Platform, PlatformContext } from "../platform/types.js";
import { loadConfig } from "../config/loader.js";
import {
  checkMempalaceProjectInitialized,
  runMempalaceSetup,
  snapshotMempalaceInstall,
  steerMempalaceInitialization,
} from "../mempalace/installer-helper.js";
import {
  getMempalacePostCommitHookStatus,
  installMempalacePostCommitHook,
  uninstallMempalacePostCommitHook,
  type MempalacePostCommitHookStatusResult,
} from "../mempalace/git-hook.js";

const SUBCOMMANDS = [
  { name: "status", description: "Show palace path, managed venv, and install status" },
  { name: "setup", description: "Install or repair the managed Python environment and MemPalace package" },
  { name: "git-hook", description: "Manage the opt-in post-commit MemPalace reindex hook" },
] as const;

const GIT_HOOK_ACTIONS = [
  { name: "status", description: "Show post-commit reindex hook status" },
  { name: "install", description: "Install or update the post-commit reindex hook" },
  { name: "uninstall", description: "Remove the managed hook and restore a chained user hook" },
] as const;

const HELP = [
  "/supi:memory — native MemPalace integration",
  "",
  "Subcommands:",
  ...SUBCOMMANDS.map((subcommand) => `  ${subcommand.name.padEnd(10)} ${subcommand.description}`),
  "",
  "Git hook:",
  "  git-hook status|install|uninstall",
  "",
  "Memory APIs are exposed to the agent via the `mempalace` tool.",
].join("\n");

function statusReport(platform: Platform, cwd: string): string {
  const config = loadConfig(platform.paths, cwd);
  const snap = snapshotMempalaceInstall(platform.paths, cwd, config);
  const lines = [
    "/supi:memory status",
    "",
    `enabled: ${snap.enabled}`,
    `palace path: ${config.mempalace.palacePath}`,
    `default wing strategy: ${config.mempalace.defaultWingStrategy}`,
    `managed venv: ${snap.venvPath}`,
    `managed python: ${snap.venvPython} (${snap.venvInstalled ? "present" : "missing"})`,
    `managed uv: ${snap.uvPath} (${snap.uvInstalled ? "present" : "missing"})`,
    `bridge script: ${snap.bridgeOk ? snap.bridgePath : `${snap.bridgePath} (missing)`}`,
    `package version: ${snap.packageVersion}`,
    "",
    snap.ready
      ? "Run `/supi:memory setup` again to upgrade or repair the managed environment."
      : "Run `/supi:memory setup` to install the managed environment.",
  ];
  return lines.join("\n");
}

function gitHookStatusReport(result: MempalacePostCommitHookStatusResult): string {
  if (!result.ok) {
    return [
      "/supi:memory git-hook status",
      "",
      `status: unavailable (${result.code})`,
      result.message,
    ].join("\n");
  }

  return [
    "/supi:memory git-hook status",
    "",
    `repo root: ${result.repoRoot}`,
    `hooks dir: ${result.hooksDir}`,
    `core.hooksPath: ${result.coreHooksPath ?? "(default .git/hooks)"}`,
    `post-commit hook: ${result.installed ? "present" : "missing"}`,
    `managed by supipowers: ${result.managed}`,
    `chained user hook: ${result.userHookPresent ? result.userHookPath : "none"}`,
    `reindex runner: ${result.runnerPresent ? result.runnerPath : `${result.runnerPath} (missing)`}`,
  ].join("\n");
}

async function handleGitHook(platform: Platform, ctx: PlatformContext, action: string): Promise<void> {
  const config = loadConfig(platform.paths, ctx.cwd);
  const command = action || "status";

  if (command === "status") {
    const status = await getMempalacePostCommitHookStatus({
      paths: platform.paths,
      cwd: ctx.cwd,
      config,
      exec: platform.exec,
    });
    ctx.ui.notify(gitHookStatusReport(status), status.ok ? "info" : "warning");
    return;
  }

  if (command === "install") {
    const result = await installMempalacePostCommitHook({
      paths: platform.paths,
      cwd: ctx.cwd,
      config,
      exec: platform.exec,
    });
    if (result.ok) {
      ctx.ui.notify(
        `MemPalace post-commit reindex hook ${result.action}: ${result.hookPath}`,
        "info",
      );
    } else {
      ctx.ui.notify(`MemPalace post-commit hook install failed (${result.code}): ${result.message}`, "warning");
    }
    return;
  }

  if (command === "uninstall") {
    const result = await uninstallMempalacePostCommitHook({
      paths: platform.paths,
      cwd: ctx.cwd,
      config,
      exec: platform.exec,
    });
    if (result.ok) {
      ctx.ui.notify(`MemPalace post-commit reindex hook ${result.action}.`, "info");
    } else {
      ctx.ui.notify(`MemPalace post-commit hook uninstall failed (${result.code}): ${result.message}`, "warning");
    }
    return;
  }

  ctx.ui.notify(`Unknown /supi:memory git-hook action: ${command}\n\n${HELP}`, "warning");
}

async function runSetup(platform: Platform, ctx: PlatformContext): Promise<void> {
  const config = loadConfig(platform.paths, ctx.cwd);
  if (!config.mempalace.enabled) {
    ctx.ui.notify("MemPalace integration is disabled in config (mempalace.enabled=false). Enable it before running setup.", "warning");
    return;
  }

  const snap = snapshotMempalaceInstall(platform.paths, ctx.cwd, config);
  if (!snap.bridgeOk) {
    ctx.ui.notify(`MemPalace bridge missing at ${snap.bridgePath}. Reinstall supipowers and retry.`, "error");
    return;
  }

  ctx.ui.notify(
    [
      "/supi:memory setup",
      "",
      `palace path:   ${config.mempalace.palacePath}`,
      `managed venv:  ${config.mempalace.managedVenvPath}`,
      `package:       mempalace==${snap.packageVersion} (PyPI)`,
      "",
      "This may take a minute on first install while ChromaDB and native deps are built.",
    ].join("\n"),
    "info",
  );

  const exec = async (command: string, args: string[], options?: { input?: string; timeoutMs?: number }) => {
    const result = await platform.exec(command, args, {
      cwd: ctx.cwd,
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };

  const result = await runMempalaceSetup({
    paths: platform.paths,
    cwd: ctx.cwd,
    config,
    runner: exec,
    onProgress: (message) => ctx.ui.notify(`MemPalace setup: ${message}`, "info"),
  });

  if (!result.ok) {
    const stderr = result.stderrTail ? `\n\n${result.stderrTail}` : "";
    ctx.ui.notify(
      `MemPalace setup failed (${result.error.code}): ${result.error.message}\n${result.error.remediation ?? ""}${stderr}`.trim(),
      "error",
    );
    return;
  }

  ctx.ui.notify(
    [
      "MemPalace setup complete.",
      `uv:      ${result.details.uvPath} (${result.details.uvVersion})`,
      `python:  ${result.details.managedPython} (managed by uv)`,
      `venv:    ${result.details.venvPath}`,
      `package: mempalace==${result.details.packageVersion}`,
    ].join("\n"),
    "info",
  );


  if (config.mempalace.hooks.postCommitReindex) {
    const hookResult = await installMempalacePostCommitHook({
      paths: platform.paths,
      cwd: ctx.cwd,
      config,
      exec: platform.exec,
    });
    if (hookResult.ok) {
      ctx.ui.notify(
        `MemPalace post-commit reindex hook ${hookResult.action}: ${hookResult.hookPath}`,
        "info",
      );
    } else {
      ctx.ui.notify(
        `MemPalace setup completed, but post-commit hook install failed (${hookResult.code}): ${hookResult.message}`,
        "warning",
      );
    }
  }
  // Check if the current project's wing is already initialized; if not, steer
  // the model to run init + mine through the mempalace tool.
  const initState = await checkMempalaceProjectInitialized({
    paths: platform.paths,
    cwd: ctx.cwd,
    config,
  });

  if (initState.initialized) {
    ctx.ui.notify(
      `MemPalace project wing \`${initState.wing}\` is already initialized.`,
      "info",
    );
    return;
  }

  const steered = steerMempalaceInitialization(platform, {
    wing: initState.wing,
    cwd: ctx.cwd,
  });
  if (steered) {
    ctx.ui.notify(
      `Steering the agent to initialize project wing \`${initState.wing}\` (running mempalace init + mine).`,
      "info",
    );
  } else {
    ctx.ui.notify(
      `Project wing \`${initState.wing}\` not initialized. Ask the agent to run mempalace(action="init", dir=".", yes=true).`,
      "warning",
    );
  }
}

export function handleMemory(platform: Platform, ctx: PlatformContext, args?: string): void {
  if (!ctx.hasUI) return;

  const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? "";
  if (sub === "" || sub === "help" || sub === "--help" || sub === "-h") {
    ctx.ui.notify(HELP, "info");
    return;
  }

  if (sub === "status") {
    try {
      ctx.ui.notify(statusReport(platform, ctx.cwd), "info");
    } catch (err) {
      ctx.ui.notify(`MemPalace status failed: ${(err as Error).message}`, "error");
    }
    return;
  }

  if (sub === "setup") {
    void (async () => {
      try {
        await runSetup(platform, ctx);
      } catch (err) {
        ctx.ui.notify(`MemPalace setup crashed: ${(err as Error).message}`, "error");
      }
    })();
    return;
  }

  if (sub === "git-hook") {
    void (async () => {
      try {
        await handleGitHook(platform, ctx, parts[1] ?? "status");
      } catch (err) {
        ctx.ui.notify(`MemPalace git-hook command crashed: ${(err as Error).message}`, "error");
      }
    })();
    return;
  }

  ctx.ui.notify(`Unknown /supi:memory subcommand: ${sub}\n\n${HELP}`, "warning");
}

export function registerMemoryCommand(platform: Platform): void {
  platform.registerCommand("supi:memory", {
    description: "Manage native MemPalace integration (status, setup, git-hook)",
    getArgumentCompletions(prefix: string) {
      const rawLower = prefix.toLowerCase();
      const lower = rawLower.trim();
      if (rawLower.startsWith("git-hook ")) {
        const actionPrefix = rawLower.slice("git-hook ".length).trimStart();
        const matches = GIT_HOOK_ACTIONS
          .filter((action) => action.name.startsWith(actionPrefix))
          .map((action) => ({
            value: `git-hook ${action.name} `,
            label: action.name,
            description: action.description,
          }));
        return matches.length > 0 ? matches : null;
      }
      const matches = SUBCOMMANDS
        .filter((subcommand) => subcommand.name.startsWith(lower))
        .map((subcommand) => ({
          value: `${subcommand.name} `,
          label: subcommand.name,
          description: subcommand.description,
        }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args: string | undefined, ctx: any) {
      handleMemory(platform, ctx, args);
    },
  });
}
