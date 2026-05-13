import type { ContextModeLazyToolsConfig } from "../types.js";
import {
  BALANCED_KEYWORD_TOOLS,
  CONTEXT_MODE_TOOL_NAMES,
  isSupiOwnedTool,
  orderOwnedTools,
} from "./tool-groups.js";

export interface ActiveToolPlannerDiagnostics {
  unknownConfiguredTools: string[];
  unavailableTools: string[];
}

export interface PlanActiveToolsInput {
  prompt: string;
  currentActive: string[];
  allTools: string[];
  lazyTools: ContextModeLazyToolsConfig;
  cacheHandlesEnabled?: boolean;
}

export interface ActiveToolPlan {
  activeTools: string[];
  activated: string[];
  deactivated: string[];
  diagnostics: ActiveToolPlannerDiagnostics;
}

const RARE_CONTEXT_TOOLS = new Set(["ctx_stats", "ctx_purge"]);

export function planActiveTools(input: PlanActiveToolsInput): ActiveToolPlan {
  const registeredOwnedTools = new Set(input.allTools.filter(isSupiOwnedTool));
  const selectedOwnedTools = new Set<string>();
  const diagnostics: ActiveToolPlannerDiagnostics = {
    unknownConfiguredTools: [],
    unavailableTools: [],
  };

  const addRegisteredTool = (toolName: string, source: "config" | "policy"): void => {
    if (!isSupiOwnedTool(toolName)) {
      if (source === "config") diagnostics.unknownConfiguredTools.push(toolName);
      return;
    }
    if (!registeredOwnedTools.has(toolName)) {
      if (source === "config") diagnostics.unavailableTools.push(toolName);
      return;
    }
    selectedOwnedTools.add(toolName);
  };

  for (const toolName of input.lazyTools.alwaysKeep) {
    addRegisteredTool(toolName, "config");
  }

  if (input.cacheHandlesEnabled) {
    addRegisteredTool("ctx_open_cached", "policy");
  }

  if (input.lazyTools.mode === "conservative") {
    for (const toolName of CONTEXT_MODE_TOOL_NAMES) {
      if (!RARE_CONTEXT_TOOLS.has(toolName)) addRegisteredTool(toolName, "policy");
    }
  }

  for (const toolName of getTriggeredTools(input.prompt, BALANCED_KEYWORD_TOOLS)) {
    addRegisteredTool(toolName, "policy");
  }

  for (const toolName of getTriggeredTools(input.prompt, input.lazyTools.keywordTools)) {
    addRegisteredTool(toolName, "config");
  }


  for (const toolName of getCommandAllowlistTools(input.prompt, input.lazyTools.commandAllowlist)) {
    addRegisteredTool(toolName, "config");
  }

  const activeTools = orderPlannedTools({
    currentActive: input.currentActive,
    selectedOwnedTools,
  });

  return {
    activeTools,
    activated: activeTools.filter((toolName) => !input.currentActive.includes(toolName)),
    deactivated: input.currentActive.filter((toolName) => !activeTools.includes(toolName)),
    diagnostics: dedupeDiagnostics(diagnostics),
  };
}

function orderPlannedTools(input: {
  currentActive: string[];
  selectedOwnedTools: Set<string>;
}): string[] {
  const activeTools: string[] = [];
  const push = (toolName: string): void => {
    if (!activeTools.includes(toolName)) activeTools.push(toolName);
  };

  for (const toolName of input.currentActive) {
    if (!isSupiOwnedTool(toolName)) push(toolName);
  }

  for (const toolName of input.currentActive) {
    if (input.selectedOwnedTools.has(toolName)) push(toolName);
  }

  const newlySelectedOwnedTools = [...input.selectedOwnedTools].filter(
    (toolName) => !input.currentActive.includes(toolName),
  );
  for (const toolName of orderOwnedTools(newlySelectedOwnedTools)) {
    push(toolName);
  }

  return activeTools;
}

function getTriggeredTools(prompt: string, keywordTools: Record<string, string[]>): string[] {
  const normalizedPrompt = normalizePrompt(prompt);
  const triggeredTools: string[] = [];

  if (/https?:\/\/\S+/i.test(prompt)) {
    triggeredTools.push("ctx_fetch_and_index");
  }
  if (/cache:\/\/[a-f0-9]{8,}/i.test(prompt)) {
    triggeredTools.push("ctx_open_cached");
  }

  for (const [term, tools] of Object.entries(keywordTools)) {
    if (literalTermMatches(normalizedPrompt, term)) {
      triggeredTools.push(...tools);
    }
  }

  return triggeredTools;
}

function getCommandAllowlistTools(
  prompt: string,
  commandAllowlist: Record<string, string[]>,
): string[] {
  const commandName = parseLeadingCommandName(prompt);
  if (!commandName) return [];
  return commandAllowlist[commandName] ?? [];
}

function parseLeadingCommandName(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const command = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
  return command || null;
}

function literalTermMatches(normalizedPrompt: string, rawTerm: string): boolean {
  const normalizedTerm = normalizePrompt(rawTerm);
  if (!normalizedTerm) return false;
  if (/\s/.test(normalizedTerm)) return normalizedPrompt.includes(normalizedTerm);
  return containsSingleTokenLiteral(normalizedPrompt, normalizedTerm);
}

function containsSingleTokenLiteral(normalizedPrompt: string, normalizedTerm: string): boolean {
  let start = normalizedPrompt.indexOf(normalizedTerm);
  while (start !== -1) {
    const before = start === 0 ? "" : normalizedPrompt[start - 1];
    const afterIndex = start + normalizedTerm.length;
    const after = afterIndex >= normalizedPrompt.length ? "" : normalizedPrompt[afterIndex];
    if (!isAsciiWordChar(before) && !isAsciiWordChar(after)) return true;
    start = normalizedPrompt.indexOf(normalizedTerm, start + 1);
  }
  return false;
}

function isAsciiWordChar(char: string): boolean {
  return /^[A-Za-z0-9_]$/.test(char);
}

function normalizePrompt(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeDiagnostics(diagnostics: ActiveToolPlannerDiagnostics): ActiveToolPlannerDiagnostics {
  return {
    unknownConfiguredTools: [...new Set(diagnostics.unknownConfiguredTools)],
    unavailableTools: [...new Set(diagnostics.unavailableTools)],
  };
}
