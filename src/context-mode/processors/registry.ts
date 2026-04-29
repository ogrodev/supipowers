import type { ContextModeProcessorFamily, ContextModeProcessorsConfig } from "../../types.js";
import type { Processor } from "./types.js";
import { gitProcessor } from "./git.js";
import { testRunnerProcessor } from "./test-runner.js";
import { jsonContentSniff, jsonProcessor } from "./json.js";
import { logContentSniff, logProcessor } from "./log.js";
import { lintProcessor } from "./lint.js";
import { buildProcessor } from "./build.js";
import { k8sProcessor } from "./k8s.js";
import { dockerProcessor } from "./docker.js";

export interface ProcessorLookupOptions {
  processors?: ContextModeProcessorsConfig;
}

export interface ProcessorMatch {
  key: ContextModeProcessorFamily;
  processor: Processor;
}

interface ArgvRoute {
  key: ContextModeProcessorFamily;
  pattern: RegExp;
}

interface ContentSniffRoute {
  key: ContextModeProcessorFamily;
  predicate: (text: string) => boolean;
}

export const ARGV_TABLE: readonly ArgvRoute[] = [
  { key: "git", pattern: /^\s*git\s+(?:status|diff|log|show|branch|stash)\b/ },
  { key: "test", pattern: /^\s*(?:bun\s+test|(?:npx\s+)?(?:vitest|jest))\b/ },
  { key: "log", pattern: /^\s*(?:tail\s+-f|journalctl|less\s+\+F)\b/ },
  { key: "lint", pattern: /^\s*(?:eslint\b|biome\s+(?:check|lint)\b|prettier\s+--check\b)/ },
  { key: "build", pattern: /^\s*(?:tsc\b|cargo\s+(?:build|check)\b|go\s+build\b|esbuild\b|next\s+build\b|bun\s+run\s+build\b)/ },
  { key: "k8s", pattern: /^\s*kubectl\s+(?:get|describe|logs|top)\b/ },
  { key: "docker", pattern: /^\s*docker\s+(?:ps|images|logs|inspect|build)\b/ },
];
export const CONTENT_SNIFF: readonly ContentSniffRoute[] = [
  { key: "json", predicate: jsonContentSniff },
  { key: "log", predicate: logContentSniff },
];

function isEnabled(
  key: ContextModeProcessorFamily,
  config: ContextModeProcessorsConfig | undefined,
): boolean {
  if (config?.enabled === false) return false;
  return !(config?.disable ?? []).includes(key);
}

export function getProcessor(key: ContextModeProcessorFamily): Processor | null {
  switch (key) {
    case "git":
      return gitProcessor;
    case "test":
      return testRunnerProcessor;
    case "json":
      return jsonProcessor;
    case "log":
      return logProcessor;
    case "lint":
      return lintProcessor;
    case "build":
      return buildProcessor;
    case "k8s":
      return k8sProcessor;
    case "docker":
      return dockerProcessor;
    default:
      return null;
  }
}

function commandFromInput(input: Record<string, unknown>): string {
  const command = input.command;
  return typeof command === "string" ? command : "";
}

export function lookupProcessor(
  canonicalTool: string,
  input: Record<string, unknown>,
  text: string,
  options: ProcessorLookupOptions = {},
): ProcessorMatch | null {
  const processorsConfig = options.processors;
  if (processorsConfig?.enabled === false) return null;

  if (canonicalTool === "bash") {
    const command = commandFromInput(input);
    for (const route of ARGV_TABLE) {
      if (!isEnabled(route.key, processorsConfig)) continue;
      if (!route.pattern.test(command)) continue;
      if (
        (route.key === "k8s" || route.key === "docker")
        && isEnabled("json", processorsConfig)
        && jsonContentSniff(text)
      ) {
        const json = getProcessor("json");
        return json ? { key: "json", processor: json } : null;
      }
      const processor = getProcessor(route.key);
      return processor ? { key: route.key, processor } : null;
    }
  }

  for (const route of CONTENT_SNIFF) {
    if (!isEnabled(route.key, processorsConfig)) continue;
    if (!route.predicate(text)) continue;
    const processor = getProcessor(route.key);
    return processor ? { key: route.key, processor } : null;
  }

  return null;
}
