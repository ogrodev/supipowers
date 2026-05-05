// src/config/defaults.ts
import type { SupipowersConfig } from "../types.js";

export const DEFAULT_CONFIG: SupipowersConfig = {
  version: "1.0.0",
  quality: {
    gates: {},
  },
  lsp: {
    setupGuide: true,
  },
  qa: {
    framework: null,
    e2e: false,
  },
  release: {
    channels: [],
    tagFormat: "v${version}",
    customChannels: {},
  },
  ultraplan: {
    slots: {},
    reviewGates: {},
  },
  contextMode: {
    enabled: true,
    compressionThreshold: 4096,
    blockHttpCommands: true,
    routingInstructions: true,
    eventTracking: true,
    compaction: true,
    llmSummarization: false,
    llmThreshold: 16384,
    enforceRouting: true,
    processors: {
      enabled: true,
      disable: [],
    },
    lazyTools: {
      enabled: true,
      mode: "balanced",
      alwaysKeep: ["ctx_execute", "ctx_search", "ctx_open_cached", "mcpc_manager"],
      commandAllowlist: {},
      keywordTools: {},
    },
    cacheHandles: {
      enabled: true,
      spillThresholdBytes: 50 * 1024,
      previewBytes: 3 * 1024,
    },
    repomap: {
      enabled: true,
      tokenBudget: 4000,
      maxFiles: 500,
    },
    memory: {
      enabled: true,
      byteBudget: 4 * 1024,
      maxRows: 25,
      retentionDays: 30,
      focusChainCadence: 6,
    },
  },
  mcp: {
    closeSessionsOnExit: false,
  },
  mempalace: {
    enabled: true,
    packageVersion: "3.3.4",
    managedVenvPath: "~/.omp/supipowers/mempalace-venv",
    palacePath: "~/.mempalace/palace",
    defaultWingStrategy: "repo-name",
    explicitWing: null,
    defaultAgentName: "omp",
    autoSetup: false,
    hooks: {
      wakeUp: true,
      searchGuidance: true,
      compactionCheckpoint: true,
      shutdownDiary: true,
    },
    budgets: {
      wakeUpTokens: 1200,
      searchResultChars: 12000,
      listResultChars: 12000,
      diaryChars: 8000,
    },
    timeouts: {
      setupMs: 120000,
      bridgeMs: 30000,
      hookMs: 10000,
    },
  },
};
