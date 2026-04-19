import type {
  CommandGateConfig,
  CommandGateId,
  CommandGateRun,
  GateDefinition,
  GateIssue,
  ProjectFacts,
  ProjectFactsTarget,
  WorkspaceTarget,
} from "../../types.js";
import { GATE_CONFIG_SCHEMAS } from "../registry.js";

interface TargetDetectedCommand {
  target: ProjectFactsTarget;
  command: string;
  confidence: "high" | "medium";
  source: string;
}

interface DetectedCommandPlan {
  runs: CommandGateRun[];
  confidence: "high" | "medium";
  reason: string;
}

interface CommandGateOptions<TGateId extends CommandGateId> {
  id: TGateId;
  label: string;
  description: string;
  scriptNames: string[];
  matchScript?: (name: string, command: string) => boolean;
}

function normalizeCommand(command: string | undefined): string | null {
  const trimmed = command?.trim();
  return trimmed ? trimmed : null;
}

function formatTargetLocation(target: Pick<ProjectFactsTarget, "kind" | "relativeDir">): string {
  return target.kind === "root" ? "root" : target.relativeDir;
}

function describeRunSelector(target: CommandGateRun["target"]): string {
  switch (target.scope) {
    case "all-targets":
      return "all targets";
    case "root":
      return "root target";
    case "all-workspaces":
      return "all workspace targets";
    case "workspace":
      return `workspace ${target.relativeDir}`;
  }
}

function detectCommandInTarget(
  target: ProjectFactsTarget,
  options: CommandGateOptions<CommandGateId>,
): TargetDetectedCommand | null {
  for (const scriptName of options.scriptNames) {
    const command = normalizeCommand(target.packageScripts[scriptName]);
    if (!command) {
      continue;
    }

    if (options.matchScript && !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      target,
      command,
      confidence: "high",
      source: `package.json ${scriptName} script`,
    };
  }

  if (!options.matchScript) {
    return null;
  }

  for (const [scriptName, rawCommand] of Object.entries(target.packageScripts)) {
    const command = normalizeCommand(rawCommand);
    if (!command || !options.matchScript(scriptName, command)) {
      continue;
    }

    return {
      target,
      command,
      confidence: "medium",
      source: `package.json ${scriptName} script by command heuristic`,
    };
  }

  return null;
}

function detectCommands(projectFacts: ProjectFacts, options: CommandGateOptions<CommandGateId>): TargetDetectedCommand[] {
  return projectFacts.targets
    .map((target) => detectCommandInTarget(target, options))
    .filter((match): match is TargetDetectedCommand => match !== null);
}

function buildDetectedRuns(matches: TargetDetectedCommand[]): CommandGateRun[] {
  const uniqueCommands = [...new Set(matches.map((match) => match.command))];
  if (uniqueCommands.length === 1) {
    return [{ command: uniqueCommands[0]!, target: { scope: "all-targets" } }];
  }

  const rootMatch = matches.find((match) => match.target.kind === "root");
  const workspaceMatches = matches.filter((match) => match.target.kind === "workspace");
  const runs: CommandGateRun[] = [];

  if (rootMatch) {
    runs.push({ command: rootMatch.command, target: { scope: "root" } });
  }

  if (workspaceMatches.length > 0) {
    const workspaceCommands = [...new Set(workspaceMatches.map((match) => match.command))];
    if (workspaceCommands.length === 1) {
      runs.push({ command: workspaceCommands[0]!, target: { scope: "all-workspaces" } });
    } else {
      runs.push(
        ...workspaceMatches.map((match) => ({
          command: match.command,
          target: { scope: "workspace", relativeDir: match.target.relativeDir } as const,
        })),
      );
    }
  }

  return runs;
}

function describeDetectedPlan(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
  matches: TargetDetectedCommand[],
  runs: CommandGateRun[],
): string {
  if (projectFacts.targets.length === 1) {
    return `Detected ${matches[0]!.source}.`;
  }

  if (runs.length === 1 && runs[0]?.target.scope === "all-targets") {
    return `Detected ${options.label.toLowerCase()} command shared across all targets via per-target scripts.`;
  }

  if (
    runs.length === 2
    && runs.some((run) => run.target.scope === "root")
    && runs.some((run) => run.target.scope === "all-workspaces")
  ) {
    return `Detected ${options.label.toLowerCase()} commands covering the root target and all workspace targets via per-target scripts.`;
  }

  if (runs.length === 1 && runs[0]?.target.scope === "all-workspaces") {
    return `Detected ${options.label.toLowerCase()} command shared across all workspace targets via per-target scripts.`;
  }

  return `Detected ${options.label.toLowerCase()} commands covering every target via per-target scripts.`;
}

function detectCompleteCommandPlan(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
): DetectedCommandPlan | null {
  const matches = detectCommands(projectFacts, options);
  if (matches.length !== projectFacts.targets.length) {
    return null;
  }

  const runs = buildDetectedRuns(matches);
  return {
    runs,
    confidence: matches.every((match) => match.confidence === "high") ? "high" : "medium",
    reason: describeDetectedPlan(projectFacts, options, matches, runs),
  };
}

function describeIncompleteCoverage(
  projectFacts: ProjectFacts,
  options: CommandGateOptions<CommandGateId>,
): string | null {
  if (projectFacts.targets.length <= 1) {
    return null;
  }

  const matches = detectCommands(projectFacts, options);
  if (matches.length === 0 || matches.length === projectFacts.targets.length) {
    return null;
  }

  const targetLocations = matches.map((match) => formatTargetLocation(match.target));
  const rootMatched = matches.some((match) => match.target.kind === "root");

  if (!rootMatched && matches.every((match) => match.target.kind === "workspace")) {
    return `Detected ${options.label.toLowerCase()} commands in workspace targets only (${targetLocations.join(", ")}), not in the root target. /supi:checks All also runs the root target, so this gate was not auto-configured.`;
  }

  return `Detected ${options.label.toLowerCase()} commands only in some targets (${targetLocations.join(", ")}). /supi:checks All runs every target, so this gate was not auto-configured.`;
}

function runMatchesTarget(run: CommandGateRun, target: WorkspaceTarget): boolean {
  switch (run.target.scope) {
    case "all-targets":
      return true;
    case "root":
      return target.kind === "root";
    case "all-workspaces":
      return target.kind === "workspace";
    case "workspace":
      return target.kind === "workspace" && target.relativeDir === run.target.relativeDir;
  }
}

function createFailureDetail(label: string, exitCode: number, stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || `${label} command exited with code ${exitCode}.`;
}

function createFailureIssue(
  label: string,
  detail: string,
  target: WorkspaceTarget,
  run: CommandGateRun,
): GateIssue {
  return {
    severity: "error",
    message: `${label} command failed for ${formatTargetLocation(target)} (${describeRunSelector(run.target)}).`,
    detail,
  };
}

export function createCommandGate<TGateId extends CommandGateId>(
  options: CommandGateOptions<TGateId>,
): GateDefinition<CommandGateConfig> {
  return {
    id: options.id,
    description: options.description,
    configSchema: GATE_CONFIG_SCHEMAS[options.id],
    detect(projectFacts) {
      const detectedPlan = detectCompleteCommandPlan(projectFacts, options);
      if (detectedPlan) {
        return {
          suggestedConfig: {
            enabled: true,
            runs: detectedPlan.runs,
          },
          confidence: detectedPlan.confidence,
          reason: detectedPlan.reason,
        };
      }

      const incompleteCoverage = describeIncompleteCoverage(projectFacts, options);
      if (!incompleteCoverage) {
        return null;
      }

      return {
        suggestedConfig: null,
        confidence: "medium",
        reason: incompleteCoverage,
      };
    },
    async run(context, config) {
      if (config.enabled !== true || !Array.isArray(config.runs)) {
        throw new Error(`${options.id} gate requires an enabled config with runs.`);
      }

      const matchingRuns = config.runs.filter((run) => runMatchesTarget(run, context.target));
      if (matchingRuns.length === 0) {
        return {
          gate: options.id,
          status: "skipped",
          summary: `${options.label} skipped for ${formatTargetLocation(context.target)} — no configured run matches this target.`,
          issues: [],
          metadata: {
            target: context.target.relativeDir,
            reason: "no-matching-runs",
          },
        };
      }

      const executedRuns: Array<{ command: string; target: CommandGateRun["target"]; exitCode: number }> = [];
      for (const run of matchingRuns) {
        const result = await context.execShell(run.command, {
          cwd: context.cwd,
          timeout: 120_000,
        });
        executedRuns.push({ command: run.command, target: run.target, exitCode: result.code });

        if (result.code !== 0) {
          const detail = createFailureDetail(options.label, result.code, result.stdout, result.stderr);
          return {
            gate: options.id,
            status: "failed",
            summary: `${options.label} failed for ${formatTargetLocation(context.target)}.`,
            issues: [createFailureIssue(options.label, detail, context.target, run)],
            metadata: {
              target: context.target.relativeDir,
              runs: executedRuns,
              failedCommand: run.command,
            },
          };
        }
      }

      return {
        gate: options.id,
        status: "passed",
        summary: `${options.label} passed.`,
        issues: [],
        metadata: {
          target: context.target.relativeDir,
          runs: executedRuns,
        },
      };
    },
  };
}
