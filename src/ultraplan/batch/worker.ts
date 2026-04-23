import type { Platform } from "../../platform/types.js";
import {
  runUltraPlanSession,
  type RunUltraPlanSessionInput,
  type UltraPlanRunOutcome,
} from "../execution/session-runner.js";

export interface RunUltraPlanBatchWorkerInput {
  platform: Platform;
  sessionId: string;
  worktreeCwd: string;
  deps?: {
    runSession?: (input: RunUltraPlanSessionInput) => Promise<UltraPlanRunOutcome>;
  };
}

export async function runUltraPlanBatchWorker(
  input: RunUltraPlanBatchWorkerInput,
): Promise<UltraPlanRunOutcome> {
  const runSession = input.deps?.runSession ?? runUltraPlanSession;
  return runSession({
    platform: input.platform,
    cwd: input.worktreeCwd,
    sessionId: input.sessionId,
  });
}
