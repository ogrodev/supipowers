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
  },
  release: {
    pipeline: null,
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
