export type ColonyPhase = "scouting" | "planning" | "workers" | "review" | "complete";

export interface ColonySignal {
  phase: ColonyPhase;
  progress: number;
  message: string;
}

export function normalizeColonySignal(phase: ColonyPhase, progress: number, message: string): ColonySignal {
  const clamped = Math.max(0, Math.min(1, progress));
  return {
    phase,
    progress: clamped,
    message,
  };
}
