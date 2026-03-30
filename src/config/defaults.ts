// src/config/defaults.ts
import type { SupipowersConfig, Profile } from "../types.js";

export const DEFAULT_CONFIG: SupipowersConfig = {
  version: "1.0.0",
  defaultProfile: "thorough",
  orchestration: {
    maxParallelAgents: 3,
    maxFixRetries: 2,
    maxNestingDepth: 2,
    modelPreference: "auto",
    taskTimeout: 600_000, // 10 minutes
  },
  lsp: {
    setupGuide: true,
  },
  notifications: {
    verbosity: "normal",
  },
  qa: {
    framework: null,
    command: null,
    e2e: false,
  },
  release: {
    pipeline: null,
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

export const BUILTIN_PROFILES: Record<string, Profile> = {
  quick: {
    name: "quick",
    gates: {
      lspDiagnostics: true,
      aiReview: { enabled: true, depth: "quick" },
      codeQuality: false,
      testSuite: false,
      e2e: false,
    },
    orchestration: {
      reviewAfterEachBatch: false,
      finalReview: false,
    },
  },
  thorough: {
    name: "thorough",
    gates: {
      lspDiagnostics: true,
      aiReview: { enabled: true, depth: "deep" },
      codeQuality: true,
      testSuite: false,
      e2e: false,
    },
    orchestration: {
      reviewAfterEachBatch: true,
      finalReview: true,
    },
  },
  "full-regression": {
    name: "full-regression",
    gates: {
      lspDiagnostics: true,
      aiReview: { enabled: true, depth: "deep" },
      codeQuality: true,
      testSuite: true,
      e2e: true,
    },
    orchestration: {
      reviewAfterEachBatch: true,
      finalReview: true,
    },
  },
};
