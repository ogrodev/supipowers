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
  notifications: {
    verbosity: "normal",
  },
  qa: {
    framework: null,
    e2e: false,
  },
  release: {
    channels: [],
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
  },
  mcp: {
    closeSessionsOnExit: false,
  },
};
