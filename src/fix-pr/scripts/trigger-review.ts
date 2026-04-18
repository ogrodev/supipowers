import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliCommand } from "./exec.js";

export interface TriggerReviewResult {
  triggered: boolean;
  reviewer: string;
  error?: string;
}

function buildResult(result: TriggerReviewResult): string {
  return JSON.stringify(result);
}

function postIssueComment(repo: string, prNumber: number, body: string): TriggerReviewResult {
  const result = runCliCommand("gh", [
    "api",
    `repos/${repo}/issues/${prNumber}/comments`,
    "-f",
    `body=${body}`,
  ]);

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "gh api comment request failed");
  }

  return { triggered: true, reviewer: "comment" };
}

export function triggerReview(
  repo: string,
  prNumber: number,
  reviewer: string,
  triggerMethod = "",
): { exitCode: number; output: string } {
  try {
    switch (reviewer) {
      case "coderabbit": {
        postIssueComment(repo, prNumber, triggerMethod);
        return { exitCode: 0, output: buildResult({ triggered: true, reviewer: "coderabbit" }) };
      }
      case "copilot": {
        if (triggerMethod) {
          postIssueComment(repo, prNumber, triggerMethod);
        } else {
          runCliCommand("gh", [
            "api",
            `repos/${repo}/pulls/${prNumber}/requested_reviewers`,
            "--method",
            "POST",
            "-f",
            "reviewers[]=copilot",
          ]);
        }
        return { exitCode: 0, output: buildResult({ triggered: true, reviewer: "copilot" }) };
      }
      case "gemini": {
        postIssueComment(repo, prNumber, triggerMethod);
        return { exitCode: 0, output: buildResult({ triggered: true, reviewer: "gemini" }) };
      }
      case "none":
        return { exitCode: 0, output: buildResult({ triggered: false, reviewer: "none" }) };
      default:
        return {
          exitCode: 1,
          output: buildResult({
            triggered: false,
            reviewer,
            error: `unknown reviewer type: ${reviewer}`,
          }),
        };
    }
  } catch (error) {
    return {
      exitCode: 1,
      output: buildResult({
        triggered: false,
        reviewer,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

function main(): void {
  const [repo, prNumberArg, reviewer, triggerMethod = ""] = process.argv.slice(2);
  const prNumber = Number.parseInt(prNumberArg ?? "", 10);

  if (!repo || !Number.isInteger(prNumber) || !reviewer) {
    console.log(buildResult({
      triggered: false,
      reviewer: reviewer ?? "unknown",
      error: "Usage: trigger-review.ts <owner/repo> <pr_number> <reviewer_type> <trigger_method>",
    }));
    process.exit(1);
  }

  const result = triggerReview(repo, prNumber, reviewer, triggerMethod);
  console.log(result.output);
  process.exit(result.exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
