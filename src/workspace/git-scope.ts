import { normalizeLineEndings } from "../text.js";
import type { WorkspaceTarget } from "../types.js";
import { filterPathsForWorkspaceTarget, normalizeRepoPath } from "./path-mapping.js";

const GIT_LOG_RECORD_SEPARATOR = "\u001e";
const GIT_LOG_FIELD_SEPARATOR = "\u001f";

export interface GitCommitWithFiles {
  hash: string;
  message: string;
  files: string[];
}

export function parseGitLogWithFiles(gitLog: string): GitCommitWithFiles[] {
  return normalizeLineEndings(gitLog)
    .split(GIT_LOG_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const lines = record
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const header = lines.shift();
      if (!header) {
        return [];
      }

      const [hash, message] = header.split(GIT_LOG_FIELD_SEPARATOR);
      if (!hash || !message) {
        return [];
      }

      return [{
        hash: hash.trim(),
        message: message.trim(),
        files: lines.map(normalizeRepoPath).filter(Boolean),
      }];
    });
}

export function filterGitLogWithFilesToWorkspaceTarget<TTarget extends WorkspaceTarget>(
  gitLog: string,
  targets: TTarget[],
  target: TTarget,
): GitCommitWithFiles[] {
  return parseGitLogWithFiles(gitLog)
    .map((commit) => ({
      ...commit,
      files: filterPathsForWorkspaceTarget(targets, target, commit.files),
    }))
    .filter((commit) => commit.files.length > 0);
}

export function filterGitLogOnelineToWorkspaceTarget<TTarget extends WorkspaceTarget>(
  gitLog: string,
  targets: TTarget[],
  target: TTarget,
): string {
  return filterGitLogWithFilesToWorkspaceTarget(gitLog, targets, target)
    .map((commit) => `${commit.hash.slice(0, 7)} ${commit.message}`)
    .join("\n");
}
