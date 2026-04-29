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
      alwaysKeep: ["ctx_execute", "ctx_search", "mcpc_manager"],
      commandAllowlist: {},
      keywordTools: {},
    },
  },
  mcp: {
    closeSessionsOnExit: false,
  }
};
