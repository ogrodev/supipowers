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
import { detectPencilMcp } from "../ui-design/backends/pencil-mcp.js";
import { selectPenFile } from "../ui-design/pen-selector.js";
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
  id: UiDesignBackendId | "figma-mcp" | "paper-mcp";
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

function buildBackendOptions(platform: Platform): UiDesignBackendOption[] {
  // Tool introspection is best-effort — if the harness throws, degrade pencil
  // to unavailable rather than killing the whole wizard.
  let activeTools: string[] = [];
  try {
    activeTools = platform.getActiveTools();
  } catch {
    activeTools = [];
  }
  const pencilAvailable = detectPencilMcp(activeTools);
  return [
    {
      id: "local-html",
      label: "local-html — Local HTML mockups in browser companion (recommended for v1)",
      available: true,
    },
    {
      id: "pencil-mcp",
      label: pencilAvailable
        ? "pencil-mcp — Drive a .pen file via the Pencil MCP server"
        : "pencil-mcp — not connected (start Pencil MCP server and rerun)",
      available: pencilAvailable,
    },
    { id: "figma-mcp", label: "figma-mcp — coming soon", available: false },
    { id: "paper-mcp", label: "paper-mcp — coming soon", available: false },
  ];
}

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

function loadUiDesignPromptAssets(
  options: { backend?: UiDesignBackendId } = {},
): UiDesignPromptAssets {
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

  // Backend-specific sub-agent templates live in a subdir; fall back to the
  // flat (HTML-assuming) template set when the subdir is missing.
  const backendSubdir = options.backend === "pencil-mcp" ? "pencil" : null;
  const candidates = backendSubdir
    ? [path.join(skillDir, "sub-agent-templates", backendSubdir), path.join(skillDir, "sub-agent-templates")]
    : [path.join(skillDir, "sub-agent-templates")];

  let subAgentTemplates: { name: string; content: string }[] | undefined;
  for (const templatesDir of candidates) {
    try {
      if (!fs.existsSync(templatesDir) || !fs.statSync(templatesDir).isDirectory()) continue;
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
        break;
      }
    } catch {
      // Try next candidate
    }
  }

  return { skillContent, subAgentTemplates };
}

async function runSetupWizard(platform: Platform, ctx: any): Promise<UiDesignConfig | null> {
  const options = buildBackendOptions(platform);
  const choiceLabel = await ctx.ui.select(
    "Design backend",
    options.map((option) => option.label),
    {
      helpText: "Pick a design backend (local-html is always available; pencil-mcp requires the Pencil MCP server)",
    },
  );
  if (!choiceLabel) return null;

  const selected = options.find((option) => option.label === choiceLabel);
  if (!selected) return null;
  if (!selected.available) {
    ctx.ui.notify(`Backend '${selected.id}' is not available right now.`, "warning");
    return null;
  }
  if (selected.id !== "local-html" && selected.id !== "pencil-mcp") {
    ctx.ui.notify(`Backend '${selected.id}' is not wired up yet.`, "warning");
    return null;
  }

  const cfg: UiDesignConfig = { ...DEFAULT_UI_DESIGN_CONFIG, backend: selected.id };

  if (selected.id === "local-html") {
    const portStr = await ctx.ui.input(
      "HTTP port for companion (blank = auto)",
      "",
      { helpText: "Leave blank to let the server pick a free port." },
    );
    if (portStr == null) return null;
    const trimmed = String(portStr).trim();
    if (trimmed) {
      const port = parseInt(trimmed, 10);
      if (!Number.isNaN(port) && port > 0) {
        cfg.port = port;
      }
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
      config = await runSetupWizard(platform, ctx);
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

    // ── Session + backend ────────────────────────────────────────────
    const sessionId = deps.generateUiDesignSessionId();
    const sessionDir = deps.createSessionDir(platform.paths, ctx.cwd, sessionId);

    // For pencil-mcp: pick the .pen file BEFORE startSession. The selector
    // accepts the not-yet-created session dir as the parent for the "new"
    // fallback (the directory itself was just created above for artifacts).
    let penFilePath: string | undefined;
    if (config.backend === "pencil-mcp") {
      const selection = await selectPenFile({ ctx, repoRoot, sessionDir });
      if (!selection) {
        // User cancelled before any session artifacts were produced. Remove
        // the empty session directory we just created so we don't leave
        // dead `.omp/supipowers/ui-design/<id>` folders behind.
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch {
          // non-fatal; user can clean up manually
        }
        deps.notifyInfo(ctx, "ui-design cancelled", "No .pen file selected");
        return;
      }
      penFilePath = selection.penFilePath;
      if (selection.kind === "existing") {
        deps.notifyInfo(ctx, "ui-design pen file selected", penFilePath);
      } else {
        deps.notifyInfo(ctx, "ui-design will create a new .pen", penFilePath);
      }
    }

    let backend: UiDesignBackend;
    try {
      backend = deps.getBackend(config.backend as UiDesignBackendId, {
        getActiveTools: () => platform.getActiveTools(),
      });
      startResult = await backend.startSession({
        sessionDir,
        port: config.port,
        penFilePath,
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
      ...(penFilePath ? { penFilePath } : {}),
    };
    writeInitialManifest(sessionDir, manifest);

    // ── Capture prompt options for the before_agent_start hook ───────
    const promptAssets = deps.loadUiDesignPromptAssets({ backend: config.backend });
    const promptOptions: UiDesignSystemPromptOptions = {
      dotDirDisplay: platform.paths.dotDirDisplay,
      sessionDir,
      companionUrl: startResult.url,
      backend: config.backend,
      contextScanSummary,
      topic,
      skillContent: promptAssets.skillContent,
      subAgentTemplates: promptAssets.subAgentTemplates,
      ...(penFilePath ? { penFilePath } : {}),
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
      ...(penFilePath ? { penFilePath } : {}),
    };
    deps.startUiDesignTracking(session, startResult.cleanup);

    // ── Kickoff prompt ────────────────────────────────────────────────
    const kickoff = buildUiDesignKickoffPrompt({
      topic,
      sessionDir,
      companionUrl: startResult.url,
      contextScanSummary,
      ...(penFilePath ? { penFilePath } : {}),
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
