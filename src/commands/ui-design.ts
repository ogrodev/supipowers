import * as fs from "node:fs";
import * as path from "node:path";
import type { Platform } from "../platform/types.js";
import { modelRegistry } from "../config/model-registry-instance.js";
import { applyModelOverride, createModelBridge, resolveModelForAction } from "../config/model-resolver.js";
import { loadModelConfig } from "../config/model-config.js";
import { notifyError, notifyInfo } from "../notifications/renderer.js";
import { cancelPlanTracking } from "../planning/approval-flow.js";
import {
  DEFAULT_UI_DESIGN_CONFIG,
  loadUiDesignConfig,
  saveUiDesignConfig,
  type UiDesignConfig,
} from "../ui-design/config.js";
import { scanDesignContext } from "../ui-design/scanner.js";
import {
  BackendUnavailableError,
  getBackend,
} from "../ui-design/backend-adapter.js";
import type { UiDesignBackend } from "../ui-design/backend-adapter.js";
import {
  cancelUiDesignTracking,
  createSessionDir,
  generateUiDesignSessionId,
  startUiDesignTracking,
} from "../ui-design/session.js";
import type { Manifest, UiDesignBackendId, UiDesignSession } from "../ui-design/types.js";
import { buildUiDesignKickoffPrompt, renderContextScanSummary } from "../ui-design/prompt-builder.js";
import { setUiDesignPromptOptions } from "../ui-design/system-prompt.js";
import type { UiDesignSystemPromptOptions } from "../ui-design/system-prompt.js";
import { moduleDir } from "../utils/paths.js";
import { resolveRepoRoot } from "../workspace/repo-root.js";

modelRegistry.register({
  id: "ui-design",
  category: "command",
  label: "UI Design",
  harnessRoleHint: "plan",
});

interface UiDesignPromptAssets {
  skillContent?: string;
  subAgentTemplates?: { name: string; content: string }[];
}

interface UiDesignBackendOption {
  id: UiDesignBackendId | "pencil-mcp" | "figma-mcp" | "paper-mcp";
  label: string;
  available: boolean;
}

export interface UiDesignCommandDependencies {
  loadUiDesignConfig: typeof loadUiDesignConfig;
  saveUiDesignConfig: typeof saveUiDesignConfig;
  scanDesignContext: typeof scanDesignContext;
  getBackend: typeof getBackend;
  generateUiDesignSessionId: typeof generateUiDesignSessionId;
  createSessionDir: typeof createSessionDir;
  startUiDesignTracking: typeof startUiDesignTracking;
  notifyInfo: typeof notifyInfo;
  notifyError: typeof notifyError;
  applyModelOverride: typeof applyModelOverride;
  setUiDesignPromptOptions: typeof setUiDesignPromptOptions;
  loadUiDesignPromptAssets: typeof loadUiDesignPromptAssets;
}

const DEFAULT_DEPS: UiDesignCommandDependencies = {
  loadUiDesignConfig,
  saveUiDesignConfig,
  scanDesignContext,
  getBackend,
  generateUiDesignSessionId,
  createSessionDir,
  startUiDesignTracking,
  notifyInfo,
  notifyError,
  applyModelOverride,
  setUiDesignPromptOptions,
  loadUiDesignPromptAssets,
};

const BACKEND_OPTIONS: UiDesignBackendOption[] = [
  {
    id: "local-html",
    label: "local-html — Local HTML mockups in browser companion (recommended for v1)",
    available: true,
  },
  { id: "pencil-mcp", label: "pencil-mcp — coming soon", available: false },
  { id: "figma-mcp", label: "figma-mcp — coming soon", available: false },
  { id: "paper-mcp", label: "paper-mcp — coming soon", available: false },
];

function findUiDesignSkillDir(): string | null {
  const candidates = [
    path.join(process.cwd(), "skills", "ui-design"),
    path.join(moduleDir(import.meta.url), "..", "..", "skills", "ui-design"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

function loadUiDesignPromptAssets(): UiDesignPromptAssets {
  const skillDir = findUiDesignSkillDir();
  if (!skillDir) return {};

  let skillContent: string | undefined;
  const skillPath = path.join(skillDir, "SKILL.md");
  try {
    if (fs.existsSync(skillPath) && fs.statSync(skillPath).isFile()) {
      skillContent = fs.readFileSync(skillPath, "utf-8");
    }
  } catch {
    skillContent = undefined;
  }

  let subAgentTemplates: { name: string; content: string }[] | undefined;
  const templatesDir = path.join(skillDir, "sub-agent-templates");
  try {
    if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
      const templates = fs
        .readdirSync(templatesDir)
        .filter((entry) => entry.endsWith(".md"))
        .sort()
        .map((entry) => ({
          name: path.basename(entry, ".md"),
          content: fs.readFileSync(path.join(templatesDir, entry), "utf-8"),
        }));
      if (templates.length > 0) {
        subAgentTemplates = templates;
      }
    }
  } catch {
    subAgentTemplates = undefined;
  }

  return { skillContent, subAgentTemplates };
}

async function runSetupWizard(ctx: any): Promise<UiDesignConfig | null> {
  const choiceLabel = await ctx.ui.select(
    "Design backend",
    BACKEND_OPTIONS.map((option) => option.label),
    {
      helpText: "Pick a design backend (only local-html is available in v1)",
    },
  );
  if (!choiceLabel) return null;

  const selected = BACKEND_OPTIONS.find((option) => option.label === choiceLabel);
  if (!selected) return null;
  if (!selected.available || selected.id !== "local-html") {
    ctx.ui.notify("Only local-html is available in v1. Aborting wizard.", "warning");
    return null;
  }

  const portStr = await ctx.ui.input(
    "HTTP port for companion (blank = auto)",
    "",
    { helpText: "Leave blank to let the server pick a free port." },
  );
  if (portStr == null) return null;

  const cfg: UiDesignConfig = { ...DEFAULT_UI_DESIGN_CONFIG, backend: selected.id };
  const trimmed = String(portStr).trim();
  if (trimmed) {
    const port = parseInt(trimmed, 10);
    if (!Number.isNaN(port) && port > 0) {
      cfg.port = port;
    }
  }

  return cfg;
}

function writeInitialManifest(sessionDir: string, manifest: Manifest): void {
  fs.writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

export async function handleUiDesign(
  platform: Platform,
  ctx: any,
  args: string | undefined,
  deps: UiDesignCommandDependencies = DEFAULT_DEPS,
): Promise<void> {
  let modelCleanup: () => Promise<void> = async () => {};
  let handoffStarted = false;
  let startResult: { url: string; cleanup: () => Promise<void> } | null = null;

  try {
    // Resolve + apply the ui-design model override up front.
    const modelCfg = loadModelConfig(platform.paths, ctx.cwd);
    const bridge = createModelBridge(platform);
    const resolved = resolveModelForAction("ui-design", modelRegistry, modelCfg, bridge);
    modelCleanup = await deps.applyModelOverride(platform, ctx, "ui-design", resolved);

    // ── Config ────────────────────────────────────────────────────────
    let config = deps.loadUiDesignConfig(platform.paths, ctx.cwd);
    if (!config) {
      if (!ctx.hasUI) {
        deps.notifyError(
          ctx,
          "ui-design first-run setup required",
          "Run /supi:ui-design in interactive mode for first-time setup.",
        );
        return;
      }
      config = await runSetupWizard(ctx);
      if (!config) return;
      deps.saveUiDesignConfig(platform.paths, ctx.cwd, config);
      deps.notifyInfo(ctx, "ui-design config saved", `Backend: ${config.backend}`);
    }

    // ── Resolve target directory + scan ───────────────────────────────
    const repoRoot = await resolveRepoRoot(platform, ctx.cwd);
    const contextScan = await deps.scanDesignContext(
      repoRoot,
      config.componentsGlobs ? { components: { globs: config.componentsGlobs } } : {},
    );
    const contextScanSummary = renderContextScanSummary(contextScan);

    // ── Session + backend ─────────────────────────────────────────────
    const sessionId = deps.generateUiDesignSessionId();
    const sessionDir = deps.createSessionDir(platform.paths, ctx.cwd, sessionId);

    let backend: UiDesignBackend;
    try {
      backend = deps.getBackend(config.backend as UiDesignBackendId);
      startResult = await backend.startSession({
        sessionDir,
        port: config.port,
      });
    } catch (err) {
      const message = err instanceof BackendUnavailableError ? err.message : (err as Error).message;
      deps.notifyError(ctx, "ui-design backend unavailable", message);
      return;
    }

    // ── Initial manifest ──────────────────────────────────────────────
    const topic = args?.trim() || undefined;
    const manifest: Manifest = {
      id: sessionId,
      topic,
      backend: config.backend,
      status: "in-progress",
      acknowledged: false,
      createdAt: new Date().toISOString(),
      components: [],
      sections: [],
      page: "page.html",
    };
    writeInitialManifest(sessionDir, manifest);

    // ── Capture prompt options for the before_agent_start hook ───────
    const promptAssets = deps.loadUiDesignPromptAssets();
    const promptOptions: UiDesignSystemPromptOptions = {
      dotDirDisplay: platform.paths.dotDirDisplay,
      sessionDir,
      companionUrl: startResult.url,
      backend: config.backend,
      contextScanSummary,
      topic,
      skillContent: promptAssets.skillContent,
      subAgentTemplates: promptAssets.subAgentTemplates,
    };
    deps.setUiDesignPromptOptions(promptOptions);

    // ── Track session (before sending steer) ──────────────────────────
    const session: UiDesignSession = {
      id: sessionId,
      dir: sessionDir,
      backend: config.backend,
      companionUrl: startResult.url,
      topic,
      resolvedModel: resolved,
    };
    deps.startUiDesignTracking(session, startResult.cleanup);

    // ── Kickoff prompt ────────────────────────────────────────────────
    const kickoff = buildUiDesignKickoffPrompt({
      topic,
      sessionDir,
      companionUrl: startResult.url,
      contextScanSummary,
    });
    platform.sendUserMessage(kickoff);
    cancelPlanTracking();
    handoffStarted = true;

    deps.notifyInfo(
      ctx,
      "ui-design session started",
      `${startResult.url} · session ${sessionId}`,
    );
  } catch (err) {
    deps.notifyError(ctx, "ui-design failed", (err as Error).message);
  } finally {
    if (!handoffStarted) {
      if (startResult) {
        try {
          await startResult.cleanup();
        } catch {
          // preserve the original startup error
        }
      }
      cancelUiDesignTracking("startup_failed");
      deps.setUiDesignPromptOptions(null);
      await modelCleanup();
    }
  }
}

export function registerUiDesignCommand(platform: Platform): void {
  platform.registerCommand("supi:ui-design", {
    description: "Drive the Design Director pipeline: scan context, decompose, build + critique HTML mockups",
    async handler(args: string | undefined, ctx: any) {
      await handleUiDesign(platform, ctx, args, DEFAULT_DEPS);
    },
  });
}
