import type { ResolvedMempalaceConfig } from "./config.js";

export type MempalaceGuidanceMode = "full" | "refresher";

export const MEMPALACE_TOOL_DESCRIPTION = [
  "MemPalace memory dispatcher.",
  "READ: **MUST** call `search` before answering past-fact questions unless the answer is fully derivable from the current turn or already-read files.",
  "WRITE: **MUST NOT** add, update, or delete memory unless the user explicitly asks or the current system instructions direct a specific write.",
  "NEVER call large mutators (`init`, `mine`, `split`, `repair`) unless explicitly instructed or running a setup/hook flow.",
].join(" ");

export function buildMempalaceGuidance(
  hooks: Pick<ResolvedMempalaceConfig["hooks"], "searchGuidance" | "writeGuidance">,
  mode: MempalaceGuidanceMode,
): string[] {
  const lines: string[] = [];
  if (hooks.searchGuidance) {
    lines.push(
      mode === "full"
        ? "## READ\n- You **MUST** call `mempalace(action=\"search\", query=...)` before answering questions about prior decisions, people, projects, past events, or anything you would otherwise answer from memory about this project.\n- You MAY skip search only when the answer is fully derivable from the current turn or files already read this turn. Reuse per-turn search results; do not repeat the same query."
        : "- READ: **MUST** call `mempalace(action=\"search\", query=...)` before past-fact answers unless fully derivable this turn.",
    );
  }
  if (hooks.writeGuidance) {
    lines.push(
      mode === "full"
        ? "## WRITE\n- You **MUST NOT** call write/mutation actions (`add_drawer`, `update_drawer`, `delete_drawer`, `diary_write`, `kg_add`, `kg_invalidate`, `create_tunnel`, `delete_tunnel`) unless the user explicitly asks you to remember/save/log something or the current system instructions direct a specific write.\n- You **MUST NOT** infer that a decision, preference, or observation should be stored. If memory should be updated but no explicit write instruction exists, state that the user can ask you to remember it.\n- You **MUST NOT** call large indexing/repair actions (`init`, `mine`, `split`, `repair`) unless explicitly instructed or running an approved setup/hook flow."
        : "- WRITE: **MUST NOT** mutate memory unless the user explicitly asks or current system instructions direct a specific write.",
    );
  }
  return lines;
}
