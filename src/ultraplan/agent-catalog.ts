import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import backendDomainReviewerAsset from "./default-agents/backend-domain-reviewer.md" with { type: "text" };
import backendExecutorAsset from "./default-agents/backend-executor.md" with { type: "text" };
import backendStackReviewerAsset from "./default-agents/backend-stack-reviewer.md" with { type: "text" };
import backendTesterAsset from "./default-agents/backend-tester.md" with { type: "text" };
import frontendDomainReviewerAsset from "./default-agents/frontend-domain-reviewer.md" with { type: "text" };
import frontendExecutorAsset from "./default-agents/frontend-executor.md" with { type: "text" };
import frontendStackReviewerAsset from "./default-agents/frontend-stack-reviewer.md" with { type: "text" };
import frontendTesterAsset from "./default-agents/frontend-tester.md" with { type: "text" };
import infrastructureDomainReviewerAsset from "./default-agents/infrastructure-domain-reviewer.md" with { type: "text" };
import infrastructureExecutorAsset from "./default-agents/infrastructure-executor.md" with { type: "text" };
import infrastructureStackReviewerAsset from "./default-agents/infrastructure-stack-reviewer.md" with { type: "text" };
import infrastructureTesterAsset from "./default-agents/infrastructure-tester.md" with { type: "text" };
import { inspectConfig, inspectConfigScopes } from "../config/loader.js";
import { MarkdownFrontmatterError, parseMarkdownFrontmatter } from "../markdown-frontmatter.js";
import type { PlatformPaths } from "../platform/types.js";
import type {
  ResolvedUltraPlanCatalog,
  ResolvedUltraPlanSlotBinding,
  UltraPlanAgentDefinition,
  UltraPlanAgentDefinitionSource,
  UltraPlanAgentSlotName,
  UltraPlanCatalogError,
  UltraPlanCatalogErrorCode,
  UltraPlanCatalogLoadResult,
  UltraPlanConfig,
} from "../types.js";
import {
  getUltraPlanSchemaErrors,
  ULTRAPLAN_AGENT_SLOT_NAMES,
  ULTRAPLAN_REVIEWER_SLOT_NAMES,
  UltraPlanAgentDefinitionFrontmatterSchema,
} from "./contracts.js";

const RESERVED_BUILT_IN_AGENT_NAMES = new Set<string>(ULTRAPLAN_AGENT_SLOT_NAMES);
const REVIEWER_SLOT_NAMES = new Set<UltraPlanAgentSlotName>(ULTRAPLAN_REVIEWER_SLOT_NAMES);

type UltraPlanCatalogLoadErrorCode = Extract<
  UltraPlanCatalogErrorCode,
  "invalid-agent-definition" | "duplicate-agent-name" | "reserved-agent-name" | "catalog-io"
>;

class UltraPlanCatalogLoadError extends Error {
  constructor(
    public readonly code: UltraPlanCatalogLoadErrorCode,
    message: string,
    public readonly path: string | null,
  ) {
    super(message);
    this.name = "UltraPlanCatalogLoadError";
  }
}

const BUILT_IN_AGENT_ASSETS = {
  "frontend-executor": {
    content: frontendExecutorAsset,
    filePath: fileURLToPath(new URL("./default-agents/frontend-executor.md", import.meta.url)),
  },
  "frontend-tester": {
    content: frontendTesterAsset,
    filePath: fileURLToPath(new URL("./default-agents/frontend-tester.md", import.meta.url)),
  },
  "frontend-domain-reviewer": {
    content: frontendDomainReviewerAsset,
    filePath: fileURLToPath(new URL("./default-agents/frontend-domain-reviewer.md", import.meta.url)),
  },
  "frontend-stack-reviewer": {
    content: frontendStackReviewerAsset,
    filePath: fileURLToPath(new URL("./default-agents/frontend-stack-reviewer.md", import.meta.url)),
  },
  "backend-executor": {
    content: backendExecutorAsset,
    filePath: fileURLToPath(new URL("./default-agents/backend-executor.md", import.meta.url)),
  },
  "backend-tester": {
    content: backendTesterAsset,
    filePath: fileURLToPath(new URL("./default-agents/backend-tester.md", import.meta.url)),
  },
  "backend-domain-reviewer": {
    content: backendDomainReviewerAsset,
    filePath: fileURLToPath(new URL("./default-agents/backend-domain-reviewer.md", import.meta.url)),
  },
  "backend-stack-reviewer": {
    content: backendStackReviewerAsset,
    filePath: fileURLToPath(new URL("./default-agents/backend-stack-reviewer.md", import.meta.url)),
  },
  "infrastructure-executor": {
    content: infrastructureExecutorAsset,
    filePath: fileURLToPath(new URL("./default-agents/infrastructure-executor.md", import.meta.url)),
  },
  "infrastructure-tester": {
    content: infrastructureTesterAsset,
    filePath: fileURLToPath(new URL("./default-agents/infrastructure-tester.md", import.meta.url)),
  },
  "infrastructure-domain-reviewer": {
    content: infrastructureDomainReviewerAsset,
    filePath: fileURLToPath(new URL("./default-agents/infrastructure-domain-reviewer.md", import.meta.url)),
  },
  "infrastructure-stack-reviewer": {
    content: infrastructureStackReviewerAsset,
    filePath: fileURLToPath(new URL("./default-agents/infrastructure-stack-reviewer.md", import.meta.url)),
  },
} satisfies Record<UltraPlanAgentSlotName, { content: string; filePath: string }>;

function createCatalogError(
  slot: UltraPlanAgentSlotName | null,
  code: UltraPlanCatalogErrorCode,
  message: string,
  path: string | null = null,
): UltraPlanCatalogError {
  return { slot, code, message, path };
}

function emptyResolvedCatalog(config: UltraPlanConfig | null = null): ResolvedUltraPlanCatalog {
  return {
    slots: Object.fromEntries(
      ULTRAPLAN_AGENT_SLOT_NAMES.map((slot) => [slot, null]),
    ) as ResolvedUltraPlanCatalog["slots"],
    reviewGates: structuredClone(config?.reviewGates ?? {}),
  };
}

function mapDefinitionsByName(definitions: UltraPlanAgentDefinition[]): Map<string, UltraPlanAgentDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

function mapBuiltInDefinitionsBySlot(
  definitions: UltraPlanAgentDefinition[],
): Map<UltraPlanAgentSlotName, UltraPlanAgentDefinition> {
  const bySlot = new Map<UltraPlanAgentSlotName, UltraPlanAgentDefinition>();

  for (const definition of definitions) {
    for (const slot of definition.supportedSlots) {
      if (!RESERVED_BUILT_IN_AGENT_NAMES.has(slot)) {
        continue;
      }

      bySlot.set(slot, definition);
    }
  }

  return bySlot;
}

function isSlotRequired(slot: UltraPlanAgentSlotName, config: UltraPlanConfig): boolean {
  if (!REVIEWER_SLOT_NAMES.has(slot)) {
    return true;
  }

  const reviewerSlot = slot as (typeof ULTRAPLAN_REVIEWER_SLOT_NAMES)[number];
  return config.reviewGates[reviewerSlot]?.enabled !== false;
}

function assertUniqueCustomDefinitionNames(definitions: UltraPlanAgentDefinition[]): void {
  const seen = new Map<string, string>();

  for (const definition of definitions) {
    if (RESERVED_BUILT_IN_AGENT_NAMES.has(definition.name)) {
      throw new UltraPlanCatalogLoadError(
        "reserved-agent-name",
        `Global UltraPlan agent "${definition.name}" reuses reserved built-in name. Choose a different custom agent name.`,
        definition.filePath,
      );
    }

    const existing = seen.get(definition.name);
    if (existing) {
      throw new UltraPlanCatalogLoadError(
        "duplicate-agent-name",
        `Duplicate UltraPlan agent name "${definition.name}" found in ${existing} and ${definition.filePath}.`,
        definition.filePath,
      );
    }

    seen.set(definition.name, definition.filePath);
  }
}

function mapExpectedCatalogLoadError(error: unknown): UltraPlanCatalogError | null {
  if (error instanceof UltraPlanCatalogLoadError) {
    return createCatalogError(null, error.code, error.message, error.path);
  }

  if (error instanceof MarkdownFrontmatterError) {
    return createCatalogError(null, "invalid-agent-definition", error.message, error.filePath);
  }

  const ioError = error as NodeJS.ErrnoException;
  if (error instanceof Error && typeof ioError.code === "string") {
    return createCatalogError(null, "catalog-io", error.message, ioError.path ?? null);
  }

  return null;
}

function describeConfigSource(source: "global" | "root"): string {
  return source === "root" ? "repository" : source;
}

function mapConfigInspectionErrors(scopes: ReturnType<typeof inspectConfigScopes>): UltraPlanCatalogError[] {
  return scopes.flatMap((scope) => [
    ...(scope.parseError
      ? [
          createCatalogError(
            null,
            "invalid-config",
            `${describeConfigSource(scope.scope)} config ${scope.path}: ${scope.parseError.message}`,
            scope.path,
          ),
        ]
      : []),
    ...scope.validationErrors.map((error) =>
      createCatalogError(
        null,
        "invalid-config",
        `${describeConfigSource(scope.scope)} config ${scope.path}: ${error.path}: ${error.message}`,
        scope.path,
      ),
    ),
  ]);
}

function blockCatalogFailure(
  errors: UltraPlanCatalogError[],
  config: UltraPlanConfig | null = null,
 ): UltraPlanCatalogLoadResult {
  return {
    ok: false,
    value: emptyResolvedCatalog(config),
    errors,
  };
}

function appendCatalogErrors(
  result: UltraPlanCatalogLoadResult,
  additionalErrors: UltraPlanCatalogError[],
  config: UltraPlanConfig | null,
 ): UltraPlanCatalogLoadResult {
  if (additionalErrors.length === 0) {
    return result.ok ? result : blockCatalogFailure(result.errors, config);
  }

  return blockCatalogFailure(
    result.ok ? additionalErrors : [...additionalErrors, ...result.errors],
    config,
  );
}

export function parseUltraPlanAgentMarkdown(
  content: string,
  filePath: string,
  source: UltraPlanAgentDefinitionSource,
): UltraPlanAgentDefinition {
  const { frontmatter, body } = parseMarkdownFrontmatter(content, filePath);
  const errors = getUltraPlanSchemaErrors(UltraPlanAgentDefinitionFrontmatterSchema, frontmatter);
  if (errors.length > 0) {
    throw new UltraPlanCatalogLoadError(
      "invalid-agent-definition",
      `Invalid UltraPlan agent frontmatter in ${filePath}: ${errors.join("; ")}`,
      filePath,
    );
  }

  const parsed = frontmatter as {
    name: string;
    description: string;
    supportedSlots: UltraPlanAgentSlotName[];
    model?: string;
    thinkingLevel?: UltraPlanAgentDefinition["thinkingLevel"];
    focus?: string;
  };

  return {
    name: parsed.name,
    description: parsed.description,
    supportedSlots: [...parsed.supportedSlots],
    model: parsed.model,
    thinkingLevel: parsed.thinkingLevel,
    focus: parsed.focus,
    prompt: body,
    filePath,
    source,
  };
}

export function getGlobalUltraPlanAgentsDir(paths: PlatformPaths): string {
  return paths.global("ultraplan-agents");
}

function cloneAgentDefinition(definition: UltraPlanAgentDefinition): UltraPlanAgentDefinition {
  return {
    ...definition,
    supportedSlots: [...definition.supportedSlots],
  };
}

function assertBuiltInDefinitionIntegrity(
  slot: UltraPlanAgentSlotName,
  definition: UltraPlanAgentDefinition,
 ): void {
  if (definition.name !== slot) {
    throw new UltraPlanCatalogLoadError(
      "invalid-agent-definition",
      `Built-in UltraPlan agent ${definition.filePath} must use reserved name "${slot}".`,
      definition.filePath,
    );
  }

  if (definition.supportedSlots.length !== 1 || definition.supportedSlots[0] !== slot) {
    throw new UltraPlanCatalogLoadError(
      "invalid-agent-definition",
      `Built-in UltraPlan agent ${definition.filePath} must support exactly the reserved slot "${slot}".`,
      definition.filePath,
    );
  }
}

let cachedBuiltInAgentDefinitions: UltraPlanAgentDefinition[] | null = null;

function parseBuiltInUltraPlanAgentDefinitions(): UltraPlanAgentDefinition[] {
  return ULTRAPLAN_AGENT_SLOT_NAMES.map((slot) => {
    const asset = BUILT_IN_AGENT_ASSETS[slot];
    const definition = parseUltraPlanAgentMarkdown(asset.content, asset.filePath, "built-in");
    assertBuiltInDefinitionIntegrity(slot, definition);
    return definition;
  });
}

export function loadBuiltInUltraPlanAgentDefinitions(): UltraPlanAgentDefinition[] {
  cachedBuiltInAgentDefinitions ??= parseBuiltInUltraPlanAgentDefinitions();
  return cachedBuiltInAgentDefinitions.map(cloneAgentDefinition);
}

export function loadGlobalUltraPlanAgentDefinitions(paths: PlatformPaths): UltraPlanAgentDefinition[] {
  const agentsDir = getGlobalUltraPlanAgentsDir(paths);
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  try {
    const definitions = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(agentsDir, entry.name))
      .sort((left, right) => left.localeCompare(right))
      .map((filePath) => parseUltraPlanAgentMarkdown(fs.readFileSync(filePath, "utf-8"), filePath, "global"));

    assertUniqueCustomDefinitionNames(definitions);
    return definitions;
  } catch (error) {
    if (error instanceof UltraPlanCatalogLoadError) {
      throw error;
    }

    if (error instanceof MarkdownFrontmatterError) {
      throw new UltraPlanCatalogLoadError(
        "invalid-agent-definition",
        error.message,
        error.filePath,
      );
    }

    throw new UltraPlanCatalogLoadError(
      "catalog-io",
      `Failed to load global UltraPlan agents from ${agentsDir}: ${(error as Error).message}`,
      agentsDir,
    );
  }
}

function resolveConfiguredDefinition(
  slot: UltraPlanAgentSlotName,
  config: UltraPlanConfig,
  builtInDefinitionsBySlot: Map<UltraPlanAgentSlotName, UltraPlanAgentDefinition>,
  globalDefinitionsByName: Map<string, UltraPlanAgentDefinition>,
): { binding: ResolvedUltraPlanSlotBinding | null; error: UltraPlanCatalogError | null } {
  const builtInDefinition = builtInDefinitionsBySlot.get(slot);
  if (!builtInDefinition) {
    return {
      binding: null,
      error: createCatalogError(
        slot,
        "missing-built-in-definition",
        `Missing built-in UltraPlan definition for slot "${slot}".`,
      ),
    };
  }

  const slotConfig = config.slots[slot];
  const selectedDefinition = slotConfig?.agentName
    ? globalDefinitionsByName.get(slotConfig.agentName)
    : builtInDefinition;
  if (!selectedDefinition) {
    return {
      binding: null,
      error: createCatalogError(
        slot,
        "required-slot-unresolved",
        `UltraPlan slot "${slot}" references unknown global agent "${slotConfig?.agentName}".`,
      ),
    };
  }

  if (!selectedDefinition.supportedSlots.includes(slot)) {
    return {
      binding: null,
      error: createCatalogError(
        slot,
        "unsupported-slot",
        `UltraPlan agent "${selectedDefinition.name}" does not support slot "${slot}".`,
        selectedDefinition.filePath,
      ),
    };
  }

  return {
    binding: {
      slot,
      agentType: selectedDefinition.source === "built-in" ? "built-in" : "named",
      agentName: selectedDefinition.name,
      model: slotConfig?.model ?? selectedDefinition.model ?? null,
      thinkingLevel: slotConfig?.thinkingLevel ?? selectedDefinition.thinkingLevel ?? null,
      selectionSource: slotConfig?.agentName ? "project" : "default",
      definitionSource: selectedDefinition.source,
      modelSource: slotConfig?.model
        ? "project"
        : selectedDefinition.model
          ? selectedDefinition.source
          : "unset",
      thinkingLevelSource: slotConfig?.thinkingLevel
        ? "project"
        : selectedDefinition.thinkingLevel
          ? selectedDefinition.source
          : "unset",
      definitionPath: selectedDefinition.filePath,
    },
    error: null,
  };
}

function resolveUltraPlanAgentCatalog(
  config: UltraPlanConfig,
  builtInDefinitions: UltraPlanAgentDefinition[],
  globalDefinitions: UltraPlanAgentDefinition[],
): UltraPlanCatalogLoadResult {
  const builtInDefinitionsBySlot = mapBuiltInDefinitionsBySlot(builtInDefinitions);
  const globalDefinitionsByName = mapDefinitionsByName(globalDefinitions);
  const errors: UltraPlanCatalogError[] = [];
  const slots = {} as ResolvedUltraPlanCatalog["slots"];

  for (const slot of ULTRAPLAN_AGENT_SLOT_NAMES) {
    if (!isSlotRequired(slot, config)) {
      slots[slot] = null;
      continue;
    }

    const { binding, error } = resolveConfiguredDefinition(
      slot,
      config,
      builtInDefinitionsBySlot,
      globalDefinitionsByName,
    );

    slots[slot] = binding;
    if (error) {
      errors.push(error);
    }
  }

  const value: ResolvedUltraPlanCatalog = {
    slots,
    reviewGates: structuredClone(config.reviewGates),
  };

  return errors.length === 0
    ? { ok: true, value }
    : { ok: false, value, errors };
}

export function loadUltraPlanAgentCatalog(
  paths: PlatformPaths,
  cwd: string,
 ): UltraPlanCatalogLoadResult {
  const inspection = inspectConfig(paths, cwd);
  if (!inspection.effectiveConfig) {
    return blockCatalogFailure(mapConfigInspectionErrors(inspectConfigScopes(paths, cwd)));
  }

  const config = inspection.effectiveConfig.ultraplan;

  let builtInDefinitions: UltraPlanAgentDefinition[];
  try {
    builtInDefinitions = loadBuiltInUltraPlanAgentDefinitions();
  } catch (error) {
    const mapped = mapExpectedCatalogLoadError(error);
    if (!mapped) {
      throw error;
    }

    return blockCatalogFailure([mapped], config);
  }

  let globalDefinitions: UltraPlanAgentDefinition[] = [];
  const loadErrors: UltraPlanCatalogError[] = [];
  try {
    globalDefinitions = loadGlobalUltraPlanAgentDefinitions(paths);
  } catch (error) {
    const mapped = mapExpectedCatalogLoadError(error);
    if (!mapped) {
      throw error;
    }

    loadErrors.push(mapped);
  }

  return appendCatalogErrors(
    resolveUltraPlanAgentCatalog(config, builtInDefinitions, globalDefinitions),
    loadErrors,
    config,
  );
}
