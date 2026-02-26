import { runInBatches } from "./batch-runner";

export interface CheckpointRunOptions {
  steps: string[];
  batchSize: number;
  signal?: AbortSignal;
  runStep: (step: string, index: number) => Promise<string>;
  onCheckpoint?: (data: { completed: number; total: number; latestStep: string }) => void;
}

export async function runCheckpointedSteps(options: CheckpointRunOptions): Promise<string[]> {
  const { steps, batchSize, signal, runStep, onCheckpoint } = options;
  let latest = "";

  return runInBatches({
    items: steps,
    batchSize,
    signal,
    runItem: async (step, index) => {
      const result = await runStep(step, index);
      latest = step;
      return result;
    },
    onBatchComplete: ({ completed, total }) => {
      onCheckpoint?.({ completed, total, latestStep: latest });
    },
  });
}
