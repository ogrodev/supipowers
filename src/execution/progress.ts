export interface ExecutionProgressUpdate {
  adapter: "native" | "subagent" | "ant_colony";
  phase: string;
  progress: number;
  message: string;
}
