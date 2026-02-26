export interface ExecutionCapabilities {
  subagent: boolean;
  antColony: boolean;
  antColonyStatus: boolean;
  native: boolean;
}

export interface ToolLike {
  name: string;
}

export interface AdapterSelectionHints {
  stepCount?: number;
  preferAutonomous?: boolean;
}

export function detectCapabilities(tools: ToolLike[]): ExecutionCapabilities {
  const names = new Set(tools.map((tool) => tool.name));
  return {
    subagent: names.has("subagent"),
    antColony: names.has("ant_colony"),
    antColonyStatus: names.has("bg_colony_status"),
    native: true,
  };
}

export type AdapterChoice = "ant_colony" | "subagent" | "native";

export function chooseAdapter(capabilities: ExecutionCapabilities, hints: AdapterSelectionHints = {}): AdapterChoice {
  const stepCount = hints.stepCount ?? 0;

  if (capabilities.antColony && (hints.preferAutonomous || stepCount >= 3 || !capabilities.subagent)) {
    return "ant_colony";
  }

  if (capabilities.subagent) return "subagent";
  return "native";
}
