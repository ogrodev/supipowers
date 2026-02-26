export interface BatchRunOptions<T, R> {
  items: T[];
  batchSize: number;
  signal?: AbortSignal;
  runItem: (item: T, index: number) => Promise<R>;
  onBatchComplete?: (info: { batchIndex: number; completed: number; total: number }) => void;
}

export async function runInBatches<T, R>(options: BatchRunOptions<T, R>): Promise<R[]> {
  const { items, batchSize, signal, runItem, onBatchComplete } = options;

  const safeBatchSize = Math.max(1, batchSize);
  const output: R[] = [];

  for (let i = 0; i < items.length; i += safeBatchSize) {
    if (signal?.aborted) {
      throw new Error("Execution aborted");
    }

    const batch = items.slice(i, i + safeBatchSize);
    for (let j = 0; j < batch.length; j += 1) {
      if (signal?.aborted) {
        throw new Error("Execution aborted");
      }
      const globalIndex = i + j;
      // eslint-disable-next-line no-await-in-loop
      const result = await runItem(batch[j], globalIndex);
      output.push(result);
    }

    onBatchComplete?.({
      batchIndex: Math.floor(i / safeBatchSize),
      completed: Math.min(i + batch.length, items.length),
      total: items.length,
    });
  }

  return output;
}
