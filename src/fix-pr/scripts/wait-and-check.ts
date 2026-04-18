import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPrComments, parsePrCommentsJsonl } from "../fetch-comments.js";
import type { PrComment } from "../types.js";
import { createCliPlatformExec } from "./exec.js";

export interface WaitAndCheckSummary {
  hasNewComments: boolean;
  count: number;
  iteration: number;
  error?: string;
}

function fingerprint(comment: PrComment): string {
  return `${comment.id}\t${comment.updatedAt ?? ""}`;
}

function diffComments(previous: readonly PrComment[], current: readonly PrComment[]): PrComment[] {
  if (previous.length === 0) {
    return [...current];
  }

  const previousFingerprints = new Set(previous.map(fingerprint));
  return current.filter((comment) => !previousFingerprints.has(fingerprint(comment)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitAndCheck(
  sessionDir: string,
  delaySeconds: number,
  iteration: number,
  repo: string,
  prNumber: number,
): Promise<{ exitCode: number; output: string }> {
  const snapshotsDir = path.join(sessionDir, "snapshots");
  const previousSnapshotPath = path.join(snapshotsDir, `comments-${iteration - 1}.jsonl`);
  const newSnapshotPath = path.join(snapshotsDir, `comments-${iteration}.jsonl`);

  await sleep(delaySeconds * 1_000);

  const fetchError = await fetchPrComments(
    createCliPlatformExec() as any,
    repo,
    prNumber,
    newSnapshotPath,
    process.cwd(),
  );

  if (fetchError) {
    const summary: WaitAndCheckSummary = {
      hasNewComments: false,
      count: 0,
      iteration,
      error: fetchError,
    };
    return { exitCode: 1, output: JSON.stringify(summary) };
  }

  const previousComments = fs.existsSync(previousSnapshotPath)
    ? parsePrCommentsJsonl(fs.readFileSync(previousSnapshotPath, "utf8"))
    : [];
  const currentComments = fs.existsSync(newSnapshotPath)
    ? parsePrCommentsJsonl(fs.readFileSync(newSnapshotPath, "utf8"))
    : [];
  const changedComments = diffComments(previousComments, currentComments);
  const summary: WaitAndCheckSummary = {
    hasNewComments: changedComments.length > 0,
    count: changedComments.length,
    iteration,
  };

  const lines = changedComments.map((comment) => JSON.stringify(comment));
  lines.push(JSON.stringify(summary));
  return {
    exitCode: 0,
    output: lines.join("\n"),
  };
}

async function main(): Promise<void> {
  const [sessionDir, delayArg, iterationArg, repo, prNumberArg] = process.argv.slice(2);
  const delaySeconds = Number.parseInt(delayArg ?? "", 10);
  const iteration = Number.parseInt(iterationArg ?? "", 10);
  const prNumber = Number.parseInt(prNumberArg ?? "", 10);

  if (!sessionDir || !Number.isInteger(delaySeconds) || !Number.isInteger(iteration) || !repo || !Number.isInteger(prNumber)) {
    console.log(JSON.stringify({
      hasNewComments: false,
      count: 0,
      iteration: Number.isInteger(iteration) ? iteration : 0,
      error: "Usage: wait-and-check.ts <session_dir> <delay_seconds> <iteration> <owner/repo> <pr_number>",
    }));
    process.exit(1);
  }

  const result = await waitAndCheck(sessionDir, delaySeconds, iteration, repo, prNumber);
  console.log(result.output);
  process.exit(result.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main();
}
